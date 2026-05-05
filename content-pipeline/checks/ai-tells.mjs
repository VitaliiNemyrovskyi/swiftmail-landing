// AI-tells phrase filter. Detects ChatGPT-style giveaways and structural patterns.
// Returns { passed: boolean, hits: [{type, line, snippet, suggestion}] }.
//
// HARD GATE: if hits > THRESHOLD, publish.mjs blocks until rewritten.

const BANNED_PHRASES = [
  // Generic ChatGPT vocabulary
  { pattern: /\bdelve\b/i, suggestion: 'use "look at" / "examine" / "dig into"' },
  { pattern: /\btapestry\b/i, suggestion: 'just delete' },
  { pattern: /\bnavigate\s+(?:the|this|through)\b/i, suggestion: 'use specific verb (go through, work through)' },
  { pattern: /\bunleash\b/i, suggestion: 'use concrete verb' },
  { pattern: /\belevate\b/i, suggestion: 'use concrete verb' },
  { pattern: /\bleverage\b/i, suggestion: 'use "use" / specific verb' },
  { pattern: /\brobust\b/i, suggestion: 'use concrete attribute' },
  { pattern: /\bseamless\b/i, suggestion: 'use concrete attribute' },
  { pattern: /\bcutting[- ]edge\b/i, suggestion: 'use concrete attribute' },
  { pattern: /\bgame[- ]changer\b/i, suggestion: 'use specific outcome' },
  { pattern: /\bcomprehensive\s+solution\b/i, suggestion: 'say what it actually does' },
  { pattern: /\btransform\s+your\b/i, suggestion: 'specific outcome verb' },

  // Stock filler phrases
  { pattern: /\bin\s+today'?s\s+(fast[- ]paced|digital|modern)\s+(world|landscape|era)\b/i, suggestion: 'cite a concrete year/event instead' },
  { pattern: /\bin\s+the\s+(?:digital|modern)\s+age\b/i, suggestion: 'cite a year/event' },
  { pattern: /\bit\'?s\s+important\s+to\s+note\s+that\b/i, suggestion: 'just say it' },
  { pattern: /\bit\s+is\s+worth\s+(?:noting|mentioning)\b/i, suggestion: 'just say it' },
  { pattern: /\bcabe\s+destacar\b/i, suggestion: '(Spanish AI-tell) just say it' },
  { pattern: /\bin\s+conclusion\b/i, suggestion: 'just close with a final point' },
  { pattern: /\bin\s+summary\b/i, suggestion: 'just close with a final point' },
  { pattern: /\bto\s+sum\s+up\b/i, suggestion: 'just close with a final point' },
  { pattern: /\bwithout\s+further\s+ado\b/i, suggestion: 'delete entirely' },

  // Hedging
  { pattern: /\barguably\b/i, suggestion: 'commit or remove' },
  { pattern: /\bin\s+some\s+cases\b/i, suggestion: 'specify which cases' },
  { pattern: /\bperhaps\b/i, suggestion: 'commit or remove' },
  { pattern: /\bpotentially\b/i, suggestion: 'commit or remove' },

  // Cringe humor (banned by humanizer.md)
  { pattern: /\b[A-Z][a-z]+-pressive\b/, suggestion: 'cringe pun, remove' },
  { pattern: /\b(spam|email)-(?:tastic|astrophe)\b/i, suggestion: 'cringe pun, remove' },
  { pattern: /\bthis\s+is\s+fine\b/i, suggestion: 'meme verbalized, replace with concrete observation' },
  { pattern: /\bbe\s+like\s*[—:]/i, suggestion: 'meme template, remove' },
  { pattern: /\bno\s+cap\b/i, suggestion: 'tech-bro slang, remove' },
  { pattern: /\bhits\s+different\b/i, suggestion: 'tech-bro slang, remove' },
  { pattern: /\beven\s+an?\s+AI\s+could\b/i, suggestion: 'self-referential, remove' },

  // Predictable transitions (warn, don't ban — voice.md sets caps)
  // Caught by frequency analysis below, not banned outright

  // Marketing buzz nouns
  { pattern: /\bsolutions\s+at\s+scale\b/i, suggestion: 'pick concrete claim' },
  { pattern: /\bnext-?level\b/i, suggestion: 'concrete attribute' },
  { pattern: /\bworld-?class\b/i, suggestion: 'concrete attribute' },

  // "Not just X, it's Y" framing — extremely common AI scaffolding
  { pattern: /\b(?:it|this|that)\'?s\s+not\s+just\b/i, suggestion: 'AI scaffolding — drop "it\'s not just X", say what it IS' },
  { pattern: /\b(?:it|this|that)\s+(?:isn|wasn)\'?t\s+just\b/i, suggestion: 'AI scaffolding — drop "isn\'t just X" framing' },
  { pattern: /\bnot\s+(?:just|merely|simply)\s+\w+(?:\s+\w+){0,3}[,—–-]\s+(?:it\'?s|but)\b/i, suggestion: '"not just X, it\'s Y" is AI-template framing' },

  // "X — and Y" structure when overused (em-dash structural caught separately)
  // ─ no extra phrase pattern; em-dash count handles it

  // Title case followed by colon, then lowercase expansion ("Strategy: how to...")
  // — common AI heading + explanation pattern. Flag when in body prose, not in
  // headings (those start with ##/###).
  { pattern: /^(?!#)[A-Z][a-zA-Z\s]{2,40}:\s+[a-z]/m, suggestion: 'Title-case-then-lowercase pattern reads as AI heading+expansion. Use a full sentence or actual heading.' },

  // Smart curly quotes (AI tools often output "smart quotes" automatically)
  { pattern: /[‘’“”]/, suggestion: 'Curly "smart quotes" are an AI giveaway. Use straight \' and " — markdown converts them per platform.' },

  // Other languages — Spanish AI-tells
  { pattern: /\ben\s+el\s+mundo\s+actual\b/i, suggestion: '(ES) cite year/event' },
  { pattern: /\bsoluciones?\s+integrales?\b/i, suggestion: '(ES) pick concrete claim' },
  // French
  { pattern: /\bdans\s+le\s+monde\s+d'aujourd'hui\b/i, suggestion: '(FR) cite year/event' },
  { pattern: /\bsolutions\s+complètes\b/i, suggestion: '(FR) pick concrete claim' },
  // German
  { pattern: /\bin\s+der\s+heutigen\s+schnelllebigen\s+welt\b/i, suggestion: '(DE) cite year/event' },
  { pattern: /\bumfassende\s+lösungen\b/i, suggestion: '(DE) pick concrete claim' },
  // Portuguese
  { pattern: /\bno\s+mundo\s+de\s+hoje\b/i, suggestion: '(PT) cite year/event' },
  { pattern: /\bsoluções\s+integradas\b/i, suggestion: '(PT) pick concrete claim' },
];

const STRUCTURAL_LIMITS = {
  maxEmDashes: 2,            // per article
  maxBulletLists: { perWords: 600 }, // 1 list per 600 words
  maxExclamations: 1,
  maxFurthermore: 1,
  maxAdditionally: 1,
  maxHowever: 2,
  maxMoreover: 0,            // banned outright
  maxTripleListBias: 3,      // "X, Y, and Z" — AI loves rule-of-3 to a fault
};

const MAX_HITS_BEFORE_BLOCK = 5;

/**
 * Check article body for AI-tells.
 * @param {string} body - markdown body (no frontmatter)
 * @returns {{passed: boolean, hits: Array, stats: object}}
 */
export function check(body) {
  const hits = [];
  const lines = body.split('\n');

  // Phrase scan
  for (const { pattern, suggestion } of BANNED_PHRASES) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pattern);
      if (m) {
        hits.push({
          type: 'banned-phrase',
          line: i + 1,
          snippet: lines[i].trim().slice(0, 100),
          match: m[0],
          suggestion,
        });
      }
    }
  }

  // Structural counts
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const emDashCount = (body.match(/—/g) || []).length;
  const exclamationCount = (body.match(/!/g) || []).length;
  const bulletListCount = (body.match(/^\s*[-*]\s/gm) || []).length;
  const furthermoreCount = (body.match(/\bfurthermore\b/gi) || []).length;
  const additionallyCount = (body.match(/\badditionally\b/gi) || []).length;
  const howeverCount = (body.match(/\bhowever\b/gi) || []).length;
  const moreoverCount = (body.match(/\bmoreover\b/gi) || []).length;
  // Triple-list bias: prose enumerations of exactly 3 items "X, Y, and Z"
  // and three-item bullet groupings. AI defaults to triads — humans vary.
  const tripleProseCount = (body.match(/\b\w+,\s+\w+(?:\s+\w+)?,\s+(?:and|or)\s+\w+/g) || []).length;
  // Three-bullet groups: count separators between consecutive lists of 3
  let threeBulletGroups = 0;
  for (let i = 0; i < lines.length - 2; i++) {
    const isBullet = (s) => /^\s*[-*]\s/.test(s);
    if (isBullet(lines[i]) && isBullet(lines[i + 1]) && isBullet(lines[i + 2])) {
      const isFourth = i + 3 < lines.length && isBullet(lines[i + 3]);
      const wasZero = i === 0 || !isBullet(lines[i - 1]);
      if (!isFourth && wasZero) threeBulletGroups++;
    }
  }
  const tripleListBiasTotal = tripleProseCount + threeBulletGroups;

  if (emDashCount > STRUCTURAL_LIMITS.maxEmDashes) {
    hits.push({
      type: 'structural',
      check: 'em-dash overuse',
      count: emDashCount,
      limit: STRUCTURAL_LIMITS.maxEmDashes,
      suggestion: 'Replace excess em-dashes with commas, parens, or new sentences',
    });
  }

  // Bullet lists: 1 per 600 words is fine. Each bullet group counts as ~1 list.
  // Coarse heuristic: bulletListCount > wordCount/200 means too many bullets
  if (bulletListCount * 200 > wordCount) {
    hits.push({
      type: 'structural',
      check: 'bullet-list overuse',
      count: bulletListCount,
      wordCount,
      suggestion: 'Convert some bullet lists to prose. Max 1 list per 600 words.',
    });
  }

  if (exclamationCount > STRUCTURAL_LIMITS.maxExclamations) {
    hits.push({
      type: 'structural',
      check: 'exclamation overuse',
      count: exclamationCount,
      limit: STRUCTURAL_LIMITS.maxExclamations,
      suggestion: 'Replace exclamations with declarative statements',
    });
  }

  if (furthermoreCount > STRUCTURAL_LIMITS.maxFurthermore) {
    hits.push({
      type: 'structural',
      check: '"Furthermore" overuse',
      count: furthermoreCount,
      limit: STRUCTURAL_LIMITS.maxFurthermore,
      suggestion: 'Vary transitions',
    });
  }
  if (additionallyCount > STRUCTURAL_LIMITS.maxAdditionally) {
    hits.push({
      type: 'structural',
      check: '"Additionally" overuse',
      count: additionallyCount,
      limit: STRUCTURAL_LIMITS.maxAdditionally,
      suggestion: 'Vary transitions',
    });
  }
  if (howeverCount > STRUCTURAL_LIMITS.maxHowever) {
    hits.push({
      type: 'structural',
      check: '"However" overuse',
      count: howeverCount,
      limit: STRUCTURAL_LIMITS.maxHowever,
      suggestion: 'Vary transitions',
    });
  }
  if (moreoverCount > STRUCTURAL_LIMITS.maxMoreover) {
    hits.push({
      type: 'structural',
      check: '"Moreover" banned',
      count: moreoverCount,
      suggestion: 'Use "Plus" / "And" / no transition',
    });
  }

  if (tripleListBiasTotal > STRUCTURAL_LIMITS.maxTripleListBias) {
    hits.push({
      type: 'structural',
      check: 'rule-of-3 / triple-list bias',
      count: tripleListBiasTotal,
      breakdown: { proseEnumerations: tripleProseCount, threeBulletGroups },
      limit: STRUCTURAL_LIMITS.maxTripleListBias,
      suggestion: 'AI defaults to enumerations of exactly 3. Vary list lengths (2/4/5/7), or convert some to prose with em-dash or "—"',
    });
  }

  return {
    passed: hits.length <= MAX_HITS_BEFORE_BLOCK,
    hits,
    stats: { wordCount, emDashCount, exclamationCount, bulletListCount, furthermoreCount, additionallyCount, howeverCount, moreoverCount, tripleListBiasTotal },
  };
}

/**
 * Format hits into LLM-readable feedback for re-draft.
 * @param {Array} hits
 * @returns {string}
 */
export function feedbackFor(hits) {
  return hits.map((h, i) => {
    if (h.type === 'banned-phrase') {
      return `${i + 1}. Line ${h.line}: "${h.match}" — ${h.suggestion}\n   Context: "${h.snippet}"`;
    }
    return `${i + 1}. ${h.check}: ${h.count} (limit ${h.limit ?? 'n/a'}) — ${h.suggestion}`;
  }).join('\n');
}
