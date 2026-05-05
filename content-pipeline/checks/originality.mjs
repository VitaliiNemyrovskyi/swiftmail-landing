// Originality check — n-gram similarity vs source URLs.
//
// Approach: extract 5-grams from generated text + each source.
// Compute Jaccard similarity per source. Flag if similarity > 0.15 to any
// single source (suggests too much paraphrasing of structure/expression).
//
// HARD GATE: similarity > 0.15 = block + push back to research/outline.

/**
 * Tokenize text to lowercased word array. Strips punctuation, normalizes whitespace.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Extract n-grams from a text.
 * @param {string} text
 * @param {number} n
 * @returns {Set<string>}
 */
function ngrams(text, n = 5) {
  const tokens = tokenize(text);
  const grams = new Set();
  for (let i = 0; i + n <= tokens.length; i++) {
    grams.add(tokens.slice(i, i + n).join(' '));
  }
  return grams;
}

/**
 * Jaccard similarity between two sets.
 * |A ∩ B| / |A ∪ B|
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const item of a) if (b.has(item)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Check originality of draft body against an array of source texts.
 *
 * @param {string} draft - the article body markdown
 * @param {Array<{url: string, text: string}>} sources
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.15] - max allowed Jaccard similarity to any source
 * @param {number} [opts.n=5] - n-gram size
 * @returns {{passed: boolean, scores: Array<{url, similarity, n}>, maxScore: number}}
 */
export function check(draft, sources, { threshold = 0.15, n = 5 } = {}) {
  const draftGrams = ngrams(draft, n);
  const scores = sources.map(({ url, text }) => ({
    url,
    similarity: jaccard(draftGrams, ngrams(text, n)),
    n,
  }));
  const maxScore = scores.length === 0 ? 0 : Math.max(...scores.map((s) => s.similarity));
  return {
    passed: maxScore <= threshold,
    scores,
    maxScore,
    threshold,
  };
}

/**
 * Format check result for LLM feedback.
 */
export function feedbackFor(result) {
  if (result.passed) return 'Originality OK';
  const flagged = result.scores.filter((s) => s.similarity > result.threshold);
  return flagged
    .map(
      (s, i) =>
        `${i + 1}. Too similar to ${s.url}: ${(s.similarity * 100).toFixed(1)}% (limit ${(result.threshold * 100).toFixed(0)}%). Restructure section that overlaps with this source.`
    )
    .join('\n');
}
