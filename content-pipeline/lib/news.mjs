// News fetcher — pulls RSS feeds, filters by relevance, dedupes,
// converts to topics.yaml-compatible entries.
//
// Why not use rss-parser / fast-xml-parser?
//   - RSS is regular enough to extract <item> blocks with regex
//   - One file, no dependency, no surprises with strict XML

import { slugify } from './slug.mjs';

/**
 * Fetch + parse an RSS/Atom feed. Returns array of items.
 * @param {object} feed - { name, url, boost_keywords?, keywords_required? }
 * @returns {Promise<Array<{title, url, summary, pubDate, source, sourceFeed}>>}
 */
export async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'SwiftMail-content-pipeline/0.1 (+https://swift-mail.app)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml).map((item) => ({
    ...item,
    sourceFeed: feed.name,
    sourceBoost: feed.boost_keywords || [],
    sourceRequired: feed.keywords_required || [],
  }));
}

/**
 * Tiny RSS/Atom parser — extracts items, no namespace handling.
 */
export function parseRss(xml) {
  const items = [];

  // RSS 2.0: <item>…</item>
  // Atom:    <entry>…</entry>
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[2];
    items.push({
      title: clean(extract(block, ['title'])),
      url: clean(extract(block, ['link', 'guid'])),
      summary: clean(extract(block, ['description', 'summary', 'content:encoded'])),
      pubDate: parseDate(extract(block, ['pubDate', 'published', 'updated', 'dc:date'])),
    });
  }
  return items;
}

function extract(block, tags) {
  for (const tag of tags) {
    // Self-closing href (Atom): <link href="..." />
    if (tag === 'link') {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (href) return href[1];
    }
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const found = block.match(re);
    if (found) return found[1];
  }
  return '';
}

function clean(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, '') // strip HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Score relevance of an item against the global config.
 * @param {object} item - { title, summary, sourceBoost, sourceRequired }
 * @param {object} config - news-sources.yaml parsed
 * @returns {number} score (0+); 0 means filtered out
 */
export function score(item, config) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();

  // Excluded outright?
  for (const kw of config.exclude_keywords || []) {
    if (haystack.includes(kw.toLowerCase())) return 0;
  }

  // Source-level required keywords (item must contain at least one)
  if (item.sourceRequired && item.sourceRequired.length) {
    const hasReq = item.sourceRequired.some((kw) => haystack.includes(kw.toLowerCase()));
    if (!hasReq) return 0;
  }

  // Baseline relevance: count global keyword matches
  let s = 0;
  for (const kw of config.relevance_keywords || []) {
    if (haystack.includes(kw.toLowerCase())) s++;
  }

  // Source-level boost keywords add 0.5 each
  for (const kw of item.sourceBoost || []) {
    if (haystack.includes(kw.toLowerCase())) s += 0.5;
  }

  // High-value keywords add 2 each (significant boost)
  for (const kw of config.high_value_keywords || []) {
    if (haystack.includes(kw.toLowerCase())) s += 2;
  }

  return s;
}

/**
 * Filter by age (skip news older than max_age_days).
 */
export function isFresh(item, maxAgeDays) {
  if (!item.pubDate) return true; // no date = assume fresh
  const ageDays = (Date.now() - item.pubDate.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= maxAgeDays;
}

/**
 * Convert a news item into a topics.yaml-compatible entry.
 * @param {object} item - scored news item
 * @param {string} category - one of: behavioral|comparison|deliverability|ecommerce|strategy
 */
export function toTopic(item, category = 'strategy') {
  const today = new Date().toISOString().slice(0, 10);
  const slug = `news-${today}-${slugify(item.title).slice(0, 50)}`;
  return {
    slug,
    title: titleForArticle(item),
    category,
    target_keyword: extractKeyword(item),
    angle: `Breaking news from ${item.sourceFeed}: ${item.title}. SwiftMail's take — what does this mean for small B2B/e-commerce email senders, with our beta-tester data where relevant.`,
    sources_hint: [item.url, `analysis: ${item.title}`],
    unique_data_hint: 'SwiftMail beta-tester impact (if applicable) or founder POV',
    source_type: 'news',
    source_url: item.url,
    source_feed: item.sourceFeed,
    source_pubdate: item.pubDate ? item.pubDate.toISOString().slice(0, 10) : today,
    source_relevance_score: item.score || 0,
    humor_level: 1,
    status: 'idea',
    est_words: 1200,
  };
}

/**
 * Wrap source title into an article title that signals our take.
 */
function titleForArticle(item) {
  const t = item.title.replace(/\s+\|\s+.*$/, '').trim(); // strip "| Site Name" suffix
  // Heuristic-pick a wrap based on title shape
  if (/(?:announces?|launches?|releases?|unveils?)/i.test(t)) {
    return `${t} — What Email Marketers Need to Know`;
  }
  if (/(?:price|pricing|fee|cost|raise)/i.test(t)) {
    return `${t} — Impact on Small Businesses`;
  }
  if (/(?:bug|outage|broken|fail|drop|crisis)/i.test(t)) {
    return `${t} — Diagnosis and Workaround`;
  }
  return `${t} — A Practitioner's Take`;
}

function extractKeyword(item) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  // Pick the most specific matched keyword (longest match wins)
  const candidates = [
    'gmail bulk sender', 'klaviyo pricing', 'mailchimp pricing',
    'apple mpp', 'dmarc reject', 'gdpr enforcement', 'first-party data',
    'email deliverability', 'sender reputation', 'abandoned cart',
    'transactional email', 'cold email', 'email automation',
    'email marketing', 'newsletter', 'inbox',
  ];
  for (const c of candidates) {
    if (haystack.includes(c)) return c;
  }
  return 'email marketing';
}

/**
 * Dedupe by URL + title hash.
 */
export function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Full pipeline: fetch → filter → score → dedupe → topics.
 * @param {object} config - news-sources.yaml parsed
 * @returns {Promise<Array<topic>>}
 */
export async function harvest(config) {
  const all = [];
  for (const feed of config.rss_feeds) {
    try {
      const items = await fetchFeed(feed);
      all.push(...items);
    } catch (err) {
      console.error(`  ⚠ ${feed.name}: ${err.message}`);
    }
  }

  const filtered = dedupe(
    all
      .filter((it) => isFresh(it, config.max_age_days || 5))
      .map((it) => ({ ...it, score: score(it, config) }))
      .filter((it) => it.score >= (config.min_relevance || 1))
  );

  filtered.sort((a, b) => b.score - a.score);

  const max = config.max_per_fetch || 5;
  return filtered.slice(0, max).map((it) => toTopic(it, categorize(it)));
}

/**
 * Heuristic category from item content.
 */
function categorize(item) {
  const t = `${item.title} ${item.summary}`.toLowerCase();
  if (/(deliverabil|spam|dkim|spf|dmarc|bimi|sender reputation|bounce)/i.test(t)) return 'deliverability';
  if (/(behavior|abandon|hesitat|signal|ai|tracking|session)/i.test(t)) return 'behavioral';
  if (/(klaviyo|mailchimp|active|brevo|drip|alternative|vs |comparison)/i.test(t)) return 'comparison';
  if (/(shopify|ecommerce|cart|checkout|product|store|brand)/i.test(t)) return 'ecommerce';
  return 'strategy';
}
