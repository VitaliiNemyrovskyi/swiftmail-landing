// Pexels-backed image fetcher. Searches for a relevant photo per article,
// downloads the medium-sized JPG, saves to /assets/blog/<slug>.jpg.
//
// Why Pexels?
//   - Free API, 200 req/hr, 20K/month — far above our usage
//   - No attribution required (terms allow commercial use)
//   - Quality consistently better than Picsum, Pixabay
//   - Has multiple pre-rendered sizes per photo (original / large / medium / small)
//
// Get an API key: https://www.pexels.com/api/  (free signup)
// Set: PEXELS_API_KEY=<key> in content-pipeline/.env

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BLOG_IMAGES_DIR = path.join(REPO_ROOT, 'assets', 'blog');

if (!fs.existsSync(BLOG_IMAGES_DIR)) fs.mkdirSync(BLOG_IMAGES_DIR, { recursive: true });

const PEXELS_API = 'https://api.pexels.com/v1/search';

/**
 * Search Pexels for a photo matching the query.
 *
 * When multiple articles share a query (e.g. "warning red sign" for both
 * spam-score and emails-going-to-spam), picking the top result every time
 * yields duplicate photos. Pass `slug` to deterministically pick from the
 * top-N candidates instead — same slug always gets same photo, different
 * slugs get different photos even on identical queries.
 *
 * @param {object} opts
 * @param {string} opts.query - search term
 * @param {string} [opts.slug] - article slug for hash-based candidate selection
 * @param {string} [opts.orientation='landscape']
 * @param {number} [opts.perPage=15] - candidates considered
 * @param {string} [opts.apiKey]
 * @returns {Promise<{id, photographer, src, alt} | null>}
 */
export async function search({ query, slug, orientation = 'landscape', perPage = 15, apiKey }) {
  const key = apiKey || process.env.PEXELS_API_KEY;
  if (!key) throw new Error('PEXELS_API_KEY missing. Get one at https://www.pexels.com/api/');

  const url = `${PEXELS_API}?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=${perPage}`;
  const res = await fetch(url, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Pexels rate limit hit (200 req/hr free tier)');
    throw new Error(`Pexels HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.photos || json.photos.length === 0) return null;

  // Slug-hash → candidate index. Stays in top-15 (high-quality matches still),
  // but deterministically picks a DIFFERENT photo per slug even on same query.
  const idx = slug ? hashSlug(slug) % json.photos.length : 0;
  const p = json.photos[idx];
  return {
    id: p.id,
    photographer: p.photographer,
    photographerUrl: p.photographer_url,
    pageUrl: p.url,
    src: {
      large: p.src.large,
      medium: p.src.medium,
      landscape: p.src.landscape,
    },
    alt: p.alt || query,
  };
}

function hashSlug(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Download a Pexels image to /assets/blog/<slug>.jpg.
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.url - Pexels CDN URL (use src.large or src.landscape)
 * @returns {Promise<{path, bytes}>}
 */
export async function download({ slug, url }) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Image download HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const out = path.join(BLOG_IMAGES_DIR, `${slug}.jpg`);
  fs.writeFileSync(out, buffer);
  return { path: out, bytes: buffer.length };
}

/**
 * High-level: search + download for a single slug.
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.query
 * @param {string} [opts.apiKey]
 * @returns {Promise<{path, bytes, photographer, sourceUrl, alt} | null>}
 */
export async function fetchOne({ slug, query, apiKey }) {
  const photo = await search({ query, slug, apiKey });
  if (!photo) return null;
  // Prefer 'large' (~940x627) for blog hero — good size:quality balance.
  // Fallback to 'landscape' (~1200x627) if large unavailable.
  const url = photo.src.large || photo.src.landscape || photo.src.medium;
  const result = await download({ slug, url });
  return {
    ...result,
    photographer: photo.photographer,
    sourceUrl: photo.pageUrl,
    alt: photo.alt,
  };
}

/**
 * Build a smart Pexels search query from article metadata.
 *
 * Priority order:
 *   1. explicit topic.image_query override (manual curation)
 *   2. slug-derived concrete subject (e.g. "abandoned cart" beats "ecommerce strategy")
 *   3. target_keyword cleaned of generic noise
 *   4. category-default visual query
 */
export function buildQuery(topic) {
  if (topic.image_query) return topic.image_query;

  // 1. Slug-derived subject. The slug ("abandoned-cart-email", "spf-dkim-dmarc-setup")
  // often carries more concrete visual subject than target_keyword.
  const slugSubject = slugToSubject(topic.slug || '');
  if (slugSubject) return slugSubject;

  // 2. target_keyword — clean generic noise
  const kw = (topic.target_keyword || '').trim();
  if (kw && kw.length > 0 && kw.length < 60) {
    const cleaned = kw
      .replace(/\b(setup|guide|best|complete|how to|2026|tutorial|tips)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && cleaned.length > 3) return cleaned;
  }

  // 3. Category default
  const categoryQuery = {
    deliverability: 'mailbox letters',
    behavioral: 'analytics chart screen',
    comparison: 'choose path direction',
    ecommerce: 'shopping cart store',
    strategy: 'business meeting laptop',
  };
  return categoryQuery[topic.category] || 'office laptop work';
}

/**
 * Map slug fragments to visual subjects. Picked for what photographs well
 * on Pexels (concrete objects/scenes, not abstract concepts).
 */
function slugToSubject(slug) {
  const map = [
    [/abandoned-cart/, 'empty shopping cart'],
    [/cold-email/, 'laptop email message'],
    [/cart|checkout/, 'online checkout'],
    [/spam|spam-score|going-to-spam/, 'warning red sign'],
    [/spf-dkim-dmarc|dns/, 'security padlock server'],
    [/dmarc/, 'security shield'],
    [/warm-?up|warmup/, 'fire torch flame'],
    [/deliverability/, 'mailbox letters'],
    [/migration|switch/, 'moving boxes road'],
    [/klaviyo|mailchimp|alternative/, 'comparison choice options'],
    [/shopify/, 'online shop ecommerce'],
    [/local-business/, 'small shop main street'],
    [/budget|pricing/, 'coins calculator desk'],
    [/social-media/, 'phone social media'],
    [/customer-journey|journey/, 'winding road map'],
    [/ai-explain|behavioral-ai/, 'brain neural network abstract'],
    [/behavioral-marketing/, 'analytics dashboard data'],
    [/ecommerce-email|automation-flow/, 'workflow diagram chart'],
    [/transactional/, 'envelope letter delivery'],
    [/bulk-sender|gmail/, 'inbox notification phone'],
    [/feedback-loop|isp/, 'server racks data center'],
    [/bimi/, 'brand logo verification'],
    [/api-rate|rate-limit/, 'dashboard server monitoring'],
    [/dedicated-ip/, 'server rack hardware'],
    [/key-rotation/, 'security key cryptography'],
    [/postmaster|reputation/, 'analytics chart growth'],
    [/form-friction|form/, 'person filling form online'],
    [/post-purchase|repeat/, 'happy customer package'],
    [/win-back/, 'reaching hand reconnect'],
    [/browse-abandonment/, 'person browsing store'],
    [/discount|promo/, 'sale tag price'],
    [/vip|loyalty/, 'gold star premium'],
    [/shipping/, 'delivery package box'],
    [/review/, 'five star rating'],
    [/replenishment|subscription/, 'recurring calendar schedule'],
    [/double-opt|opt-in/, 'sign up form newsletter'],
    [/gdpr|compliance|privacy/, 'lock privacy data'],
    [/subject-line/, 'open letter highlight'],
    [/from-name/, 'identification card name'],
    [/ab-test/, 'split test A B'],
    [/utm|tracking/, 'analytics dashboard graphs'],
    [/zapier|integration/, 'connected gears workflow'],
  ];
  for (const [re, q] of map) {
    if (re.test(slug)) return q;
  }
  return '';
}
