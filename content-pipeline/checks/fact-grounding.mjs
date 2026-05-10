// Fact-grounding gate. Detects specific numeric claims (dollar
// amounts, percentages, dates) that appear near a competitor name in
// the article body and cannot be verified from any of our supplied
// sources (product-context.md, topic.unique_data_hint,
// topic.sources_hint, universally-known facts).
//
// Why a separate check: ai-tells catches AI-style PHRASES ("delve
// into", "tapestry"); quality-heuristics catches sentence-rhythm and
// vagueness; eeat checks citations / first-person markers / internal
// links. None of those notice when llama-3.3-70b confidently writes
// "DigiCert charges $1500/yr for VMC" — when DigiCert's actual price
// is $400. That single fabricated number is a brand-credibility hit
// AND an E-E-A-T penalty signal (Google's Helpful Content classifier
// is hostile to fabricated specifics, especially competitor pricing).
//
// HARD GATE: a fact-grounding fail goes through the standard revision
// loop (collectGateFeedback in pipeline.mjs) — LLM is asked to either
// cite the number's source explicitly or replace it with qualitative
// language ("enterprise-priced", "tiered billing", "five-figure
// annual"). Up to 2 revision passes; if both fail the article ships
// with a warning in the daily-report email.
//
// Limitations:
//   - Only detects numbers WITHIN ~150 chars of a competitor name.
//     A standalone "$1500" floating in prose without a vendor near it
//     is allowed (could be the user's hypothetical budget).
//   - Universally-known anchor dates (iOS 15, Apple MPP 2021, GDPR
//     2018) are whitelisted in `KNOWN_FACTS`.
//   - SwiftMail's own metrics (34%, 22%, 11%, 47%, 18 days, 47 min)
//     are sourced from product-context.md so they pass automatically.

/**
 * Direct competitor / vendor names that — when paired with a specific
 * number — trigger fact-checking. Keep in sync with COMPETITOR_DOMAINS
 * in lib/markdown-render.mjs plus the few VMC issuers and ESPs whose
 * pricing the model frequently fabricates.
 *
 * Lower-cased; matched as whole-word substrings against a windowed
 * text slice around each numeric token.
 */
const VENDORS = [
  // Marketing automation competitors
  'klaviyo', 'mailchimp', 'activecampaign', 'customer.io', 'drip',
  'omnisend', 'brevo', 'mailerlite', 'encharge', 'sendinblue',
  // Enterprise behavioral platforms
  'bloomreach', 'contentsquare', 'optimizely',
  // Session-replay / analytics tools
  'hotjar', 'mouseflow', 'fullstory', 'posthog',
  // Transactional ESPs (still cite-able but model fabricates pricing)
  'sendgrid', 'postmark', 'mailgun',
  // VMC issuers (BIMI articles repeatedly invent these prices)
  'digicert', 'entrust',
  // Email QA / deliverability tools
  'litmus', 'returnpath',
];

/**
 * Universally-known anchors that the model can cite freely without
 * specific sources. Lower-cased substrings of likely contexts.
 *
 * Add carefully — every entry here is "the LLM is allowed to mention
 * this date / number specifically without needing to verify it".
 */
const KNOWN_FACTS = [
  'ios 15', 'ios 16', 'ios 17',
  'apple mpp', 'mail privacy protection',
  'september 2021', 'sept 2021', '2021', // Apple MPP rollout (loose)
  'gdpr 2018', 'gdpr 2019',
  'google bulk sender', '2024',           // Google bulk-sender Feb 2024
  'rfc 7489', 'rfc 6376', 'rfc 7208', 'rfc 5321', 'rfc 5322',
];

/** Lower-case sources blob for cheap substring lookup. */
function buildSourcesBlob({ topic = {}, productContext = '', knownFactsExtra = '' } = {}) {
  const parts = [
    productContext,
    topic.unique_data_hint || '',
    (Array.isArray(topic.sources_hint) ? topic.sources_hint.join(' ') : (topic.sources_hint || '')),
    topic.angle || '',
    topic.target_keyword || '',
    KNOWN_FACTS.join(' '),
    knownFactsExtra,
  ];
  return parts.join('\n').toLowerCase();
}

/**
 * Try to find a numeric token in the sources blob. We search for both
 * the literal form (`$1500`) and a normalised digits-only form (`1500`)
 * — the source might say `1500/year` or `$1.5K/yr` and we want both
 * to count.
 */
function isNumberInSources(numberToken, sources) {
  const lc = numberToken.toLowerCase();
  if (sources.includes(lc)) return true;
  // Strip $ , whitespace
  const digits = lc.replace(/[^\d.]/g, '');
  if (digits.length < 2) return false; // single-digit numbers are too noisy to enforce
  // Match the digits as a whole-token in sources (avoid matching "1500" inside "11500")
  const re = new RegExp(`(?:^|[^\\d])${digits.replace(/\./g, '\\.')}(?:$|[^\\d])`);
  return re.test(sources);
}

/**
 * Build a context window around an index in `text`, with `radius`
 * chars on each side. Lower-cased for substring matching.
 */
function windowAround(text, idx, length, radius = 120) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + length + radius);
  return { window: text.slice(start, end).toLowerCase(), readable: text.slice(start, end) };
}

/**
 * Run the fact-grounding check on a markdown body.
 *
 * @param {string} body - markdown article body
 * @param {object} ctx
 * @param {object} [ctx.topic] - topics.yaml entry
 * @param {string} [ctx.productContext] - product-context.md text
 * @returns {{ passed: boolean, fails: Array<{kind, number, near, context}> }}
 */
export function check(body, ctx = {}) {
  const sources = buildSourcesBlob(ctx);
  const fails = [];

  // ── 1. Dollar amounts ─────────────────────────────────────────────
  // Matches $50, $1,500, $50K, $1.4M, $20/mo, $99/year, etc.
  const dollarRe = /\$([\d,]+(?:\.\d+)?)\s*([KkMm])?(?:\s*\/\s*(?:mo(?:nth)?|yr|year))?/g;
  let m;
  while ((m = dollarRe.exec(body)) !== null) {
    const numberToken = m[0];
    const { window, readable } = windowAround(body, m.index, numberToken.length);
    const vendor = VENDORS.find((v) => window.includes(v));
    if (!vendor) continue; // standalone number, no competitor proximity → allowed
    if (isNumberInSources(numberToken, sources)) continue;
    fails.push({
      kind: 'unverified-price',
      number: numberToken,
      near: vendor,
      context: readable,
    });
  }

  // ── 2. Percentages ────────────────────────────────────────────────
  // Match \d+% but only flag when near a competitor AND not in sources.
  // SwiftMail's own metrics (34%, 22%, 11%, 47%) live in product-context
  // and pass via isNumberInSources.
  const pctRe = /\b(\d{1,3}(?:\.\d+)?)\s*%/g;
  while ((m = pctRe.exec(body)) !== null) {
    const numberToken = m[0];
    const value = parseFloat(m[1]);
    if (isNaN(value) || value < 1) continue; // skip "0.5%" noise / formatting
    const { window, readable } = windowAround(body, m.index, numberToken.length, 100);
    const vendor = VENDORS.find((v) => window.includes(v));
    if (!vendor) continue;
    if (isNumberInSources(numberToken, sources)) continue;
    // Ignore obvious universal patterns ("70.19% of carts" — Baymard,
    // already in product-context.md as canonical)
    fails.push({
      kind: 'unverified-stat',
      number: numberToken,
      near: vendor,
      context: readable,
    });
  }

  // ── 3. Specific year dates near competitor ────────────────────────
  // Catches "in May 2024 Klaviyo raised prices" — model often invents
  // these months even when the year is right.
  const dateRe = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/g;
  while ((m = dateRe.exec(body)) !== null) {
    const numberToken = m[0];
    const { window, readable } = windowAround(body, m.index, numberToken.length, 80);
    const vendor = VENDORS.find((v) => window.includes(v));
    if (!vendor) continue;
    if (isNumberInSources(numberToken, sources)) continue;
    fails.push({
      kind: 'unverified-date',
      number: numberToken,
      near: vendor,
      context: readable,
    });
  }

  return { passed: fails.length === 0, fails };
}

/**
 * Build human-readable feedback for the revision loop. The LLM reads
 * this and is expected to either remove or qualitatively-rewrite each
 * flagged claim.
 */
export function feedbackFor(result) {
  if (result.passed || result.fails.length === 0) return '';
  const lines = result.fails.map((f) => {
    const kindLabel = f.kind === 'unverified-price'
      ? 'price'
      : f.kind === 'unverified-stat'
        ? 'percentage'
        : 'date';
    return `[fact-grounding] You wrote ${kindLabel} "${f.number}" near "${f.near}" — that specific value is NOT in any provided source (product-context, sources_hint, unique_data_hint). Either:
  (a) Cite a real source: write "according to [text](url)" with a real authoritative URL, or
  (b) Replace with qualitative language. Suggested rewrites:
      • for prices: "enterprise-priced" / "tiered billing" / "five-figure annual" / "starts in the low hundreds"
      • for stats: "the majority of" / "a small fraction of" / "rare but observable"
      • for dates: drop the month, keep the year only, or remove entirely
Surrounding context for orientation: "...${f.context.slice(0, 200).trim()}..."`;
  });
  return lines.join('\n\n');
}
