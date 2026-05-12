// EEAT (Expertise, Experience, Authoritativeness, Trust) signals check.
// Google's helpful-content classifier looks for these. Each article must:
//   - Have an author byline
//   - Cite ≥2 outbound authoritative sources
//   - Contain ≥1 unique data point (SwiftMail metric / customer quote / first-hand)
//   - Link internally to ≥2 other SwiftMail blog posts
//
// HARD GATE: any failure blocks publish.

const AUTHORITATIVE_DOMAINS = [
  // Standards bodies / RFC
  'rfc-editor.org',
  'datatracker.ietf.org',
  'w3.org',
  // Major ESPs (technical references)
  'mailgun.com',
  'postmarkapp.com',
  'sendgrid.com',
  'klaviyo.com',
  'mailchimp.com',
  'activecampaign.com',
  // Big tech docs
  'developers.google.com',
  'support.google.com',
  'support.apple.com',
  'docs.microsoft.com',
  'learn.microsoft.com',
  // Research orgs
  'baymard.com',
  'litmus.com',
  'returnpath.com',
  // Trade publications
  'searchengineland.com',
  'searchengineroundtable.com',
  'martech.org',
  // Privacy/compliance
  'gdpr.eu',
  'cookielaw.org',
  // Industry data
  'similarweb.com',
  'statista.com',
];

// Unique-data signals: phrases that suggest first-hand SwiftMail data
const UNIQUE_DATA_PATTERNS = [
  /\bour\s+(?:swiftmail\s+)?data\b/i,
  /\bwe\s+(?:tested|migrated|queried|measured|observed|saw|tracked|monitored|logged)\b/i,
  /\bI\s+(?:tested|queried|migrated|measured|observed|tracked|monitored|debugged)\b/i,
  /\bin\s+our\s+(?:beta|tests|migrations|database|analysis|data)\b/i,
  /\bacross\s+(?:our\s+)?(?:100|\d+)\s+(?:beta\s+)?testers\b/i,
  /\bwhen\s+we\s+(?:migrated|set\s+up|deployed|tested)\b/i,
  /\bswiftmail\s+(?:beta|customers|testers|users|migrations)\b/i,
];

/**
 * Run EEAT signal check.
 * @param {string} body - markdown body
 * @param {object} [frontmatter]
 * @returns {{passed: boolean, fails: Array, signals: object}}
 */
export function check(body, frontmatter = {}) {
  const fails = [];

  // 1. Author byline (frontmatter `author` field OR explicit byline in body)
  const hasAuthorFM = !!frontmatter.author && frontmatter.author.length > 1;
  const hasBylineInBody = /\b(?:by|written\s+by|author:)\s+[A-Z]/i.test(body);
  if (!hasAuthorFM && !hasBylineInBody) {
    fails.push({
      check: 'author-byline',
      detail: 'No author in frontmatter and no byline in body. Add `author:` to frontmatter.',
    });
  }

  // 2. Outbound authoritative citations — DISABLED 2026-05-12.
  // Operator decision: 100% of link-juice stays on-domain, so we no
  // longer require outbound citations at all. The check is left in
  // place (still counts what's there for the signals dict + daily
  // report email) but no longer enters `fails` → won't block publish
  // or trigger a revision pass.
  //
  // Trade-off: Google's EEAT classifier rewards 2-3 outbound to real
  // authority. This stance MAY soften "expertise" signal. Revert by
  // moving the `if (authoritative.length < 2)` block back into
  // `fails.push(...)` and re-populating SUGGESTED_URLS_BY_CATEGORY +
  // RENDERER_OUTBOUND_WHITELIST.
  const outbound = extractLinks(body).filter((l) =>
    !l.url.includes('swift-mail.app') && /^https?:\/\//.test(l.url)
  );
  const authoritative = outbound.filter((l) =>
    AUTHORITATIVE_DOMAINS.some((d) => l.url.includes(d))
  );

  // 3. Unique data point (≥1 SwiftMail-specific marker)
  let uniqueDataHits = 0;
  for (const re of UNIQUE_DATA_PATTERNS) {
    if (re.test(body)) uniqueDataHits++;
  }
  if (uniqueDataHits === 0) {
    fails.push({
      check: 'unique-data-point',
      score: 0,
      threshold: 1,
      detail: 'No first-hand SwiftMail data point detected. Add at least one: "Our SwiftMail data shows...", "We tested across 100 beta testers...", "I queried sessions where..." etc.',
    });
  }

  // 4. Internal links (≥2 to other SwiftMail blog posts)
  const internal = outbound.length > 0 ? extractLinks(body).filter((l) =>
    l.url.includes('swift-mail.app') || l.url.startsWith('/')
  ) : [];
  // Just count any swift-mail.app or relative URL (cheaper than parsing)
  const internalLinks = (body.match(/\]\((?:https:\/\/swift-mail\.app|\/blog|\/features)[^)]*\)/g) || []).length;
  if (internalLinks < 2) {
    fails.push({
      check: 'internal-links',
      score: internalLinks,
      threshold: 2,
      detail: `Only ${internalLinks} internal links. Link to ≥2 other SwiftMail blog posts or feature pages.`,
    });
  }

  return {
    passed: fails.length === 0,
    fails,
    signals: {
      hasAuthor: hasAuthorFM || hasBylineInBody,
      authoritative: authoritative.length,
      authoritativeUrls: authoritative.map((l) => l.url),
      uniqueDataHits,
      internalLinks,
      totalOutbound: outbound.length,
    },
  };
}

/** Extract markdown links [text](url). */
function extractLinks(body) {
  const links = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    links.push({ text: m[1], url: m[2] });
  }
  return links;
}

export function feedbackFor(result) {
  if (result.passed) return 'EEAT signals OK';
  return result.fails
    .map((f, i) => `${i + 1}. [${f.check}] ${f.detail}`)
    .join('\n');
}
