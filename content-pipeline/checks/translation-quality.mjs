// Translation quality check. Verifies that a translated draft preserves:
//   - All brand names (SwiftMail, Klaviyo, etc.) — exact occurrence count
//   - All technical acronyms (DKIM, SPF, etc.) — exact occurrence count
//   - All code blocks — same count
//   - All <a href="..."> URLs — same set
//   - Same H2/H3 count
//   - Length within ±40% of source

const PRESERVED_BRANDS = [
  'SwiftMail', 'Klaviyo', 'Mailchimp', 'ActiveCampaign', 'Brevo', 'MailerLite',
  'Drip', 'Omnisend', 'Customer.io', 'Encharge', 'Bloomreach', 'Contentsquare',
  'Optimizely', 'Hotjar', 'Mouseflow', 'FullStory', 'PostHog', 'Shopify',
  'Stripe', 'Apple', 'Google', 'Microsoft', 'Bonobos', 'Gmail', 'Outlook',
  'Postmark', 'SendGrid', 'Mailgun',
];

const PRESERVED_ACRONYMS = [
  'DKIM', 'SPF', 'DMARC', 'BIMI', 'TLS', 'SMTP', 'IMAP', 'POP3',
  'SaaS', 'B2B', 'B2C', 'CRM', 'ESP', 'ICP', 'MQL', 'SQL', 'API', 'SDK',
  'DNS', 'JSON', 'REST', 'JWT', 'OAuth', 'CORS', 'CSP', 'XSS',
  'GMV', 'ARR', 'MRR', 'CAC', 'LTV', 'CTR', 'CPC', 'CPM', 'ROAS', 'ROI',
  'NPS', 'TAM', 'SAM', 'SOM', 'MAU', 'DAU', 'PMF',
];

/**
 * Count exact-match occurrences of a term in text.
 */
function countOccurrences(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  return (text.match(re) || []).length;
}

/**
 * Extract all <a href="..."> URLs from markdown body.
 */
function extractUrls(body) {
  const urls = new Set();
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(body)) !== null) urls.add(m[1]);
  return urls;
}

/**
 * Count code blocks (triple-backtick fenced).
 */
function countCodeBlocks(body) {
  return (body.match(/```/g) || []).length / 2;
}

/**
 * Count H2 / H3.
 */
function countHeadings(body) {
  return {
    h2: (body.match(/^## /gm) || []).length,
    h3: (body.match(/^### /gm) || []).length,
  };
}

/**
 * Check a translation against its source.
 *
 * @param {string} source - English markdown body
 * @param {string} translation - target-language markdown body
 * @param {string} lang - 'es' | 'fr' | 'de' | 'pt'
 * @param {object} [opts]
 * @returns {{passed: boolean, fails: Array, stats: object}}
 */
export function check(source, translation, lang, opts = {}) {
  const fails = [];
  const stats = {};

  // 1. Brand-name preservation
  for (const brand of PRESERVED_BRANDS) {
    const srcCount = countOccurrences(source, brand);
    if (srcCount === 0) continue;
    const tgtCount = countOccurrences(translation, brand);
    if (tgtCount !== srcCount) {
      fails.push({
        check: 'brand-name-preservation',
        brand,
        sourceCount: srcCount,
        translationCount: tgtCount,
        detail: `Brand "${brand}" appears ${srcCount}× in source but ${tgtCount}× in translation. It must be preserved exactly.`,
      });
    }
  }

  // 2. Acronym preservation
  for (const acronym of PRESERVED_ACRONYMS) {
    const srcCount = countOccurrences(source, acronym);
    if (srcCount === 0) continue;
    const tgtCount = countOccurrences(translation, acronym);
    if (tgtCount !== srcCount) {
      fails.push({
        check: 'acronym-preservation',
        acronym,
        sourceCount: srcCount,
        translationCount: tgtCount,
        detail: `Acronym "${acronym}" appears ${srcCount}× in source but ${tgtCount}× in translation. Must be preserved exactly.`,
      });
    }
  }

  // 3. Code-block count
  const srcCodeBlocks = countCodeBlocks(source);
  const tgtCodeBlocks = countCodeBlocks(translation);
  if (srcCodeBlocks !== tgtCodeBlocks) {
    fails.push({
      check: 'code-block-count',
      detail: `Code blocks: ${srcCodeBlocks} in source, ${tgtCodeBlocks} in translation. Must match.`,
    });
  }

  // 4. URL preservation (must include all source URLs)
  const srcUrls = extractUrls(source);
  const tgtUrls = extractUrls(translation);
  const missing = [...srcUrls].filter((u) => !tgtUrls.has(u));
  if (missing.length > 0) {
    fails.push({
      check: 'url-preservation',
      missing,
      detail: `URLs missing in translation: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`,
    });
  }

  // 5. Heading count parity (H2/H3)
  const srcH = countHeadings(source);
  const tgtH = countHeadings(translation);
  if (srcH.h2 !== tgtH.h2 || srcH.h3 !== tgtH.h3) {
    fails.push({
      check: 'heading-parity',
      detail: `Source: ${srcH.h2} H2 + ${srcH.h3} H3. Translation: ${tgtH.h2} H2 + ${tgtH.h3} H3. Should match.`,
    });
  }

  // 6. Length within ±40%
  const srcWords = source.split(/\s+/).filter(Boolean).length;
  const tgtWords = translation.split(/\s+/).filter(Boolean).length;
  const lengthRatio = tgtWords / srcWords;
  // Different languages have different natural ratios:
  const expected = { es: 1.15, fr: 1.18, de: 1.25, pt: 1.12 };
  const expectedRatio = expected[lang] || 1.0;
  const deviation = Math.abs(lengthRatio - expectedRatio) / expectedRatio;
  if (deviation > 0.4) {
    fails.push({
      check: 'length-deviation',
      sourceWords: srcWords,
      translationWords: tgtWords,
      ratio: Number(lengthRatio.toFixed(2)),
      expected: expectedRatio,
      detail: `Translation is ${(lengthRatio * 100).toFixed(0)}% of source length. Expected around ${(expectedRatio * 100).toFixed(0)}% for ${lang}. Likely missing or expanded sections.`,
    });
  }

  stats.sourceWords = srcWords;
  stats.translationWords = tgtWords;
  stats.lengthRatio = Number(lengthRatio.toFixed(2));
  stats.codeBlocks = { source: srcCodeBlocks, translation: tgtCodeBlocks };
  stats.urls = { source: srcUrls.size, translation: tgtUrls.size };
  stats.headings = { source: srcH, translation: tgtH };

  return { passed: fails.length === 0, fails, stats };
}

export function feedbackFor(result) {
  if (result.passed) return 'Translation quality OK';
  return result.fails
    .map((f, i) => `${i + 1}. [${f.check}] ${f.detail}`)
    .join('\n');
}
