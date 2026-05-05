// Quality heuristics check. Validates that generated content has the
// signal hallmarks of human-written B2B prose:
//   - Sentence-length variance (humans vary, AI tends consistent)
//   - Concrete-vs-vague ratio (numbers, names, specifics > generics)
//   - First-person experience markers
//   - Specific examples
//
// HARD GATE: any threshold failure = block + suggest fix.

const FIRST_PERSON_MARKERS = [
  /\bwe\s+(?:tested|migrated|queried|observed|tried|found|saw|watched|set\s+up|implemented|deployed|measured)\b/gi,
  /\bI\s+(?:tested|migrated|queried|observed|tried|found|saw|watched|set\s+up|implemented|deployed|measured)\b/gi,
  /\bour\s+(?:swiftmail|data|metrics|tests|customers|beta|tester|migration)\b/gi,
  /\bin\s+our\s+(?:analysis|data|tests|experiments|migrations)\b/gi,
];

// Specificity markers: actual numbers, percentages, dollar amounts, dates, named entities
const SPECIFICITY_MARKERS = [
  /\b\d+(\.\d+)?%/g,                       // 12.5%, 47%
  /\$\d+(\.\d+)?(?:k|K|m|M)?/g,            // $20, $50K
  /\b\d{4,}\b/g,                           // years like 2026, big numbers
  /\b\d+(?:-|\s+to\s+)\d+\b/g,             // ranges
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/g, // dates
  /\b(?:Klaviyo|Mailchimp|ActiveCampaign|Brevo|MailerLite|Drip|Omnisend|Customer\.io|Encharge|Bloomreach|Contentsquare|Hotjar|FullStory|PostHog|Clarity|Mouseflow|Postmark|SendGrid|Mailgun|Shopify|Stripe|Apple|Google|Microsoft|Bonobos|SwiftMail)\b/g,
  /\b(?:DKIM|SPF|DMARC|BIMI|TLS|SMTP|API|SDK|CRM|ESP|SaaS|B2B|MQL|LTV|CAC|ARR|MRR|CTR|CPC|MAU|DAU|GMV|TAM|ICP|ROI|ROAS)\b/g, // acronyms (real ones)
];

const VAGUE_PHRASES = [
  /\bmany\s+(?:businesses|companies|brands|users|customers|tools)\b/gi,
  /\bmost\s+(?:businesses|companies|brands|users|customers|tools)\b/gi,
  /\bvarious\s+\w+/gi,
  /\bnumerous\s+\w+/gi,
  /\ba\s+wide\s+range\s+of\b/gi,
  /\ba\s+variety\s+of\b/gi,
  /\bsignificant(?:ly)?\b/gi,
  /\bsubstantial(?:ly)?\b/gi,
  /\bhigh-quality\b/gi,
  /\bworld-class\b/gi,
];

/**
 * Calculate sentence-length variance (std-dev / mean).
 */
function sentenceLengthVariance(body) {
  // Strip code blocks first (their length isn't sentence variance)
  const noCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  const sentences = noCode
    .split(/(?<=[.!?])\s+(?=[A-ZА-ЯЄІЇ])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length < 5) return { variance: 0, mean: 0, sentences: sentences.length };
  const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance =
    lengths.reduce((acc, l) => acc + Math.pow(l - mean, 2), 0) / lengths.length;
  const stdev = Math.sqrt(variance);
  return {
    variance: stdev / mean,
    mean: Number(mean.toFixed(1)),
    stdev: Number(stdev.toFixed(1)),
    sentences: sentences.length,
    shortRatio: lengths.filter((l) => l < 8).length / lengths.length,
    longRatio: lengths.filter((l) => l > 25).length / lengths.length,
  };
}

/**
 * Count first-person experience markers.
 */
function firstPersonCount(body) {
  let count = 0;
  for (const re of FIRST_PERSON_MARKERS) {
    count += (body.match(re) || []).length;
  }
  return count;
}

/**
 * Count specific (concrete) markers — real numbers, brand names, real acronyms.
 */
function specificityCount(body) {
  let count = 0;
  for (const re of SPECIFICITY_MARKERS) {
    count += (body.match(re) || []).length;
  }
  return count;
}

/**
 * Count vague phrases.
 */
function vagueCount(body) {
  let count = 0;
  for (const re of VAGUE_PHRASES) {
    count += (body.match(re) || []).length;
  }
  return count;
}

/**
 * Run all quality heuristics. Returns aggregate pass/fail + per-check details.
 *
 * Thresholds:
 *   - sentence-length variance ≥ 0.4 (StdDev/Mean — human-like)
 *   - shortRatio ≥ 0.15 (≥1 in ~7 sentences under 8 words)
 *   - first-person markers ≥ 3 per article
 *   - specificity:vagueness ratio ≥ 4:1 (4 concrete markers per 1 vague)
 *
 * @param {string} body
 * @returns {{passed: boolean, fails: Array, scores: object}}
 */
export function check(body) {
  const variance = sentenceLengthVariance(body);
  const fp = firstPersonCount(body);
  const spec = specificityCount(body);
  const vague = vagueCount(body);

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const articleSize = wordCount > 1000 ? 'long' : 'short';

  const fails = [];

  if (variance.variance < 0.4 && variance.sentences >= 10) {
    fails.push({
      check: 'sentence-length-variance',
      score: variance.variance.toFixed(2),
      threshold: 0.4,
      detail: `Mean ${variance.mean} words, stdev ${variance.stdev}. Sentences feel templated. Mix in ≥1 in 5 sentences under 8 words; ≥1 in 10 over 25 words.`,
    });
  }

  if (variance.shortRatio < 0.15 && variance.sentences >= 10) {
    fails.push({
      check: 'short-sentence-ratio',
      score: variance.shortRatio.toFixed(2),
      threshold: 0.15,
      detail: `Only ${(variance.shortRatio * 100).toFixed(0)}% of sentences are under 8 words. Add some short, punchy ones.`,
    });
  }

  const minFirstPerson = articleSize === 'long' ? 3 : 1;
  if (fp < minFirstPerson) {
    fails.push({
      check: 'first-person-markers',
      score: fp,
      threshold: minFirstPerson,
      detail: `Only ${fp} first-person experience markers ("we tested", "I queried", "our SwiftMail data"). Article reads disembodied. Add ≥${minFirstPerson}.`,
    });
  }

  const specificityRatio = vague === 0 ? Infinity : spec / vague;
  if (specificityRatio < 4) {
    fails.push({
      check: 'specificity-ratio',
      score: Number.isFinite(specificityRatio) ? specificityRatio.toFixed(2) : 'inf',
      threshold: 4,
      detail: `Only ${spec} concrete markers (numbers/brand names/real acronyms) vs ${vague} vague phrases ("many businesses", "various", "significantly"). Replace generics with specifics.`,
    });
  }

  return {
    passed: fails.length === 0,
    fails,
    scores: {
      sentenceVariance: Number(variance.variance.toFixed(2)),
      meanWordsPerSentence: variance.mean,
      shortSentenceRatio: Number(variance.shortRatio.toFixed(2)),
      longSentenceRatio: Number(variance.longRatio.toFixed(2)),
      firstPersonMarkers: fp,
      specificityCount: spec,
      vagueCount: vague,
      specificityRatio: Number.isFinite(specificityRatio) ? Number(specificityRatio.toFixed(2)) : 'inf',
      wordCount,
    },
  };
}

export function feedbackFor(result) {
  if (result.passed) return 'Quality heuristics OK';
  return result.fails
    .map((f, i) => `${i + 1}. [${f.check}] score ${f.score}, threshold ${f.threshold}. ${f.detail}`)
    .join('\n');
}
