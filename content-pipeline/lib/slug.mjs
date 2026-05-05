// Slug helpers. Used by pipeline.mjs (slug generation from title) and
// publish.mjs (validating slugs, rendering URLs).

const RESERVED_SLUGS = new Set([
  'index',
  'feed',
  'rss',
  'sitemap',
  'admin',
  'api',
  'auth',
  'login',
]);

/**
 * Generate a kebab-case slug from a title.
 * Strips diacritics, lowercases, collapses non-alphanumerics to hyphens.
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  return String(title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['"]/g, '') // strip apostrophes
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Validate a slug. Throws on invalid.
 *
 * @param {string} slug
 */
export function assertValid(slug) {
  if (!slug || typeof slug !== 'string') throw new Error(`Invalid slug: ${slug}`);
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
    throw new Error(`Slug must be kebab-case [a-z0-9-], got "${slug}"`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Slug "${slug}" is reserved`);
  }
}

/**
 * Build the public URL for a slug + language.
 * @param {string} slug
 * @param {string} lang - 'en' | 'es' | 'fr' | 'de' | 'pt'
 * @returns {string}
 */
export function urlFor(slug, lang = 'en') {
  const prefix = lang === 'en' ? '' : `/${lang}`;
  return `https://swift-mail.app${prefix}/blog/${slug}.html`;
}

/**
 * Build the file-system path for a slug + language.
 * @param {string} slug
 * @param {string} lang
 * @returns {string} Path relative to repo root
 */
export function pathFor(slug, lang = 'en') {
  const prefix = lang === 'en' ? '' : `${lang}/`;
  return `${prefix}blog/${slug}.html`;
}
