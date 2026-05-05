// Editorial-diff check. Verifies that the human reviewer made meaningful
// edits to the LLM's first draft before publishing.
//
// We compare drafts/<slug>.md (current state, ready to publish) against
// drafts/<slug>.original.md (snapshot saved when LLM produced the draft).
//
// HARD GATE: diff < 25% (Levenshtein-similarity > 75%) means publish blocked
// because the human pass was skipped.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Levenshtein-distance approximation via word-level diff.
 * Returns ratio of changed words to total.
 */
function wordLevelDiff(a, b) {
  const wordsA = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wordsB = b.toLowerCase().split(/\s+/).filter(Boolean);

  // Use longest common subsequence to compute changes
  const m = wordsA.length;
  const n = wordsB.length;

  // For perf on large articles, cap at 5000 words each side
  if (m > 5000 || n > 5000) {
    return chunkedDiff(wordsA, wordsB);
  }

  // Standard LCS DP
  const dp = Array(m + 1).fill(null).map(() => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (wordsA[i - 1] === wordsB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const lcs = dp[m][n];
  const totalChanges = m + n - 2 * lcs;
  const totalWords = Math.max(m, n);
  return {
    diffRatio: totalWords === 0 ? 0 : totalChanges / (m + n),
    addedWords: n - lcs,
    removedWords: m - lcs,
    keptWords: lcs,
    totalA: m,
    totalB: n,
  };
}

/**
 * Faster chunked diff for very long articles. Splits into 1000-word
 * chunks and aggregates.
 */
function chunkedDiff(a, b) {
  const chunkSize = 1000;
  let added = 0,
    removed = 0,
    kept = 0;
  for (let start = 0; start < Math.max(a.length, b.length); start += chunkSize) {
    const sliceA = a.slice(start, start + chunkSize);
    const sliceB = b.slice(start, start + chunkSize);
    const result = wordLevelDiff(sliceA.join(' '), sliceB.join(' '));
    added += result.addedWords;
    removed += result.removedWords;
    kept += result.keptWords;
  }
  const total = added + removed + 2 * kept;
  return {
    diffRatio: total === 0 ? 0 : (added + removed) / total,
    addedWords: added,
    removedWords: removed,
    keptWords: kept,
    totalA: a.length,
    totalB: b.length,
  };
}

/**
 * Check that the current draft has been meaningfully edited from the
 * original LLM output.
 *
 * @param {string} slug
 * @param {string} draftsDir - path to drafts/ folder
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.25]
 * @returns {{passed: boolean, diffRatio: number, threshold: number, detail: string}}
 */
export function check(slug, draftsDir, { threshold = 0.25 } = {}) {
  const currentPath = path.join(draftsDir, `${slug}.md`);
  const originalPath = path.join(draftsDir, `${slug}.original.md`);

  if (!fs.existsSync(currentPath)) {
    return {
      passed: false,
      diffRatio: 0,
      threshold,
      detail: `Draft not found: ${currentPath}`,
    };
  }

  if (!fs.existsSync(originalPath)) {
    // No original snapshot — pipeline.mjs failed to save it. Allow publish
    // but flag for setup fix.
    return {
      passed: true,
      diffRatio: 0,
      threshold,
      detail: 'No .original.md snapshot — editorial-diff cannot verify. (Pipeline didn\'t save original; consider reseeding from LLM and re-saving.)',
      warning: true,
    };
  }

  const current = fs.readFileSync(currentPath, 'utf8');
  const original = fs.readFileSync(originalPath, 'utf8');

  // Strip frontmatter for diff (we care about body)
  const stripFm = (s) => s.replace(/^---\n[\s\S]*?\n---\n/, '');
  const result = wordLevelDiff(stripFm(original), stripFm(current));

  return {
    passed: result.diffRatio >= threshold,
    diffRatio: Number(result.diffRatio.toFixed(3)),
    threshold,
    addedWords: result.addedWords,
    removedWords: result.removedWords,
    keptWords: result.keptWords,
    detail:
      result.diffRatio >= threshold
        ? `Editorial-diff OK (${(result.diffRatio * 100).toFixed(1)}% changed)`
        : `Editorial pass insufficient: only ${(result.diffRatio * 100).toFixed(1)}% changed (need ≥${(threshold * 100).toFixed(0)}%). Add real customer quotes, founder takes, specific metrics, or restructure sections.`,
  };
}

export function feedbackFor(result) {
  return result.detail;
}
