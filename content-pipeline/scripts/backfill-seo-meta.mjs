#!/usr/bin/env node
// backfill-seo-meta.mjs — add the new SEO meta tag set introduced in
// PR #13 to every already-published blog HTML file.
//
// Why a separate script instead of re-running the renderer:
// the original draft .md files are gitignored + cleaned by the GHA
// runner between runs, so we can't re-call renderArticle(md, ...).
// Instead we extract metadata from the existing HTML's <head>, build
// the missing tags, and inject them surgically. Body and existing
// content untouched.
//
// Idempotent: if a file already has `<meta name="robots"` the new tags
// are skipped (this script can be safely re-run).
//
// Usage:
//   node content-pipeline/scripts/backfill-seo-meta.mjs           # all langs, dry-run
//   node content-pipeline/scripts/backfill-seo-meta.mjs --write   # actually patch files
//
// Run from the repo root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'uk'];
const OG_LOCALE = { en: 'en_US', es: 'es_ES', fr: 'fr_FR', de: 'de_DE', pt: 'pt_BR', uk: 'uk_UA' };

const WRITE = process.argv.includes('--write');

/** Decode common HTML entities so re-emitted attribute strings are clean. */
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Extract a single attribute value from a `<meta>`-ish tag. */
function metaContent(html, attrName, attrValue) {
  const re = new RegExp(`<meta\\s+${attrName}="${attrValue.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"\\s+content="([^"]*)"`, 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Inspect an existing article HTML, extract everything we need to
 * generate the new SEO tags, then return either { skip: 'reason' } or
 * the patched HTML string.
 */
function patchArticleHtml(html, langGuess) {
  // Idempotency check.
  if (html.includes('<meta name="robots"')) {
    return { skip: 'already-patched' };
  }
  if (!html.includes('</head>')) {
    return { skip: 'no-head' };
  }
  if (!html.includes('<meta property="og:type" content="article"')) {
    return { skip: 'not-article' };
  }

  // Field extraction.
  const titleM = /<title>([^<]+)<\/title>/.exec(html);
  const titleRaw = titleM ? decodeEntities(titleM[1]) : null;
  // Strip " — SwiftMail" suffix introduced by renderArticle.
  const title = titleRaw ? titleRaw.replace(/\s+—\s+SwiftMail\s*$/u, '').trim() : '';

  const desc = metaContent(html, 'name', 'description') ?? '';
  const ogUrl = metaContent(html, 'property', 'og:url') ?? '';

  // Hero image — try og:image first; fall back to the actual <img> in
  // the .blog-hero-img figure (legacy articles never had og:image at
  // all, so og:image extraction returns empty and we'd emit a broken
  // twitter:image=https://swift-mail.app/ pointer).
  let heroImageFull = metaContent(html, 'property', 'og:image') ?? '';
  if (!heroImageFull || heroImageFull === 'https://swift-mail.app' || heroImageFull === 'https://swift-mail.app/') {
    const heroImgSrcM = /<(?:figure|div)\s+class="blog-hero-img"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/.exec(html);
    if (heroImgSrcM) {
      const src = heroImgSrcM[1];
      heroImageFull = src.startsWith('http') ? src : `https://swift-mail.app${src}`;
    }
  }
  const heroImage = heroImageFull.replace(/^https?:\/\/swift-mail\.app/, '');

  // Hero alt: prefer the actual <img alt> in the .blog-hero-img figure
  // (where it's most accurate), then fall back to title.
  const heroImgAltM = /<(?:figure|div)\s+class="blog-hero-img"[^>]*>[\s\S]*?<img[^>]*alt="([^"]+)"/.exec(html);
  const heroAlt = heroImgAltM ? decodeEntities(heroImgAltM[1]) : title;

  // Date + category + author from JSON-LD Article schema.
  const ldM = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/.exec(html);
  let datePublished = '';
  let dateModified = '';
  let category = '';
  let author = 'SwiftMail';
  if (ldM) {
    try {
      const ld = JSON.parse(ldM[1]);
      const article = ld['@type'] === 'Article' ? ld : (ld['@graph'] ?? []).find((n) => n['@type'] === 'Article');
      if (article) {
        datePublished = article.datePublished || '';
        dateModified = article.dateModified || datePublished;
        author = article.author?.name || 'SwiftMail';
      }
    } catch {
      /* fall through; use defaults */
    }
  }
  // category lives on `<p class="blog-category">` in the rendered hero.
  const catM = /<p class="blog-category">([^<]+)<\/p>/.exec(html);
  if (catM) category = decodeEntities(catM[1]).trim();

  // Path-derived: lang + slug from the canonical URL.
  let lang = langGuess;
  let slug = '';
  const canonM = /<link rel="canonical" href="([^"]+)"/.exec(html);
  if (canonM) {
    const url = canonM[1];
    const m = /https?:\/\/swift-mail\.app(?:\/([a-z]{2}))?\/blog\/([^/.]+)\.html/.exec(url);
    if (m) {
      lang = m[1] || 'en';
      slug = m[2];
    }
  }

  if (!title || !slug) {
    return { skip: 'missing title/slug after extraction' };
  }

  // Tags: derive from category + a couple of dumb heuristics on slug.
  const slugTokens = slug
    .split('-')
    .filter((t) => t.length > 2 && !['the', 'and', 'for', 'why', 'how'].includes(t));
  const tags = Array.from(new Set([category, ...slugTokens.slice(0, 3)].filter(Boolean)));

  // Build the new tags block.
  const ogLocale = OG_LOCALE[lang] || 'en_US';
  const ogLocaleAlt = Object.entries(OG_LOCALE)
    .filter(([l]) => l !== lang)
    .map(([, locale]) => `  <meta property="og:locale:alternate" content="${locale}">`)
    .join('\n');
  const articleTagLines = tags
    .map((t) => `  <meta property="article:tag" content="${escapeHtml(t)}">`)
    .join('\n');
  const keywordsContent = tags.length > 0 ? tags.map(escapeHtml).join(', ') : '';

  const heroImgUrl = `https://swift-mail.app${heroImage}`;
  const newHeadInsert = [
    `  <meta name="robots" content="index,follow,max-image-preview:large">`,
    `  <meta name="author" content="${escapeHtml(author)}">`,
    keywordsContent ? `  <meta name="keywords" content="${keywordsContent}">` : null,
    `  <meta property="og:image:alt" content="${escapeHtml(heroAlt)}">`,
    `  <meta property="og:site_name" content="SwiftMail">`,
    `  <meta property="og:locale" content="${ogLocale}">`,
    ogLocaleAlt,
    datePublished ? `  <meta property="article:published_time" content="${datePublished}">` : null,
    dateModified  ? `  <meta property="article:modified_time" content="${dateModified}">`  : null,
    `  <meta property="article:author" content="${escapeHtml(author)}">`,
    category      ? `  <meta property="article:section" content="${escapeHtml(category)}">` : null,
    articleTagLines,
    `  <meta name="twitter:title" content="${escapeHtml(title)}">`,
    `  <meta name="twitter:description" content="${escapeHtml(desc)}">`,
    `  <meta name="twitter:image" content="${heroImgUrl}">`,
    `  <meta name="twitter:image:alt" content="${escapeHtml(heroAlt)}">`,
  ]
    .filter(Boolean)
    .join('\n');

  // Replace single Article JSON-LD with @graph (Article + BreadcrumbList).
  const newLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: title,
        description: desc,
        image: heroImgUrl,
        author: { '@type': 'Person', name: author, url: 'https://swift-mail.app/' },
        publisher: {
          '@type': 'Organization',
          name: 'SwiftMail',
          logo: { '@type': 'ImageObject', url: 'https://swift-mail.app/assets/logo-orange.svg' },
        },
        ...(datePublished ? { datePublished } : {}),
        ...(dateModified ? { dateModified } : {}),
        mainEntityOfPage: { '@type': 'WebPage', '@id': ogUrl },
        inLanguage: lang,
        ...(category ? { articleSection: category } : {}),
        ...(tags.length ? { keywords: tags.join(', ') } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: lang === 'en' ? 'https://swift-mail.app/' : `https://swift-mail.app/${lang}/` },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: lang === 'en' ? 'https://swift-mail.app/blog/' : `https://swift-mail.app/${lang}/blog/` },
          { '@type': 'ListItem', position: 3, name: title, item: ogUrl },
        ],
      },
    ],
  });

  let out = html;
  if (ldM) {
    out = out.replace(ldM[0], `<script type="application/ld+json">${newLd}</script>`);
  } else {
    // No prior JSON-LD — add ours.
    out = out.replace(
      '</head>',
      `  <script type="application/ld+json">${newLd}</script>\n  </head>`,
    );
  }
  // Inject new meta block before </head>.
  out = out.replace('</head>', `\n${newHeadInsert}\n</head>`);

  return { html: out, lang, slug };
}

function gatherFiles() {
  const out = [];
  for (const lang of LANGS) {
    const dir = lang === 'en' ? path.join(REPO_ROOT, 'blog') : path.join(REPO_ROOT, lang, 'blog');
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir);
    for (const f of entries) {
      if (!f.endsWith('.html') || f === 'index.html') continue;
      out.push({ path: path.join(dir, f), lang });
    }
  }
  return out;
}

(function main() {
  const files = gatherFiles();
  console.log(`scanning ${files.length} files (${WRITE ? 'WRITE mode' : 'dry-run; pass --write to apply'})\n`);

  let patched = 0;
  let skipped = 0;
  const skipReasons = {};

  for (const { path: fp, lang } of files) {
    const html = fs.readFileSync(fp, 'utf8');
    const result = patchArticleHtml(html, lang);
    if (result.skip) {
      skipped += 1;
      skipReasons[result.skip] = (skipReasons[result.skip] || 0) + 1;
      continue;
    }
    patched += 1;
    const rel = path.relative(REPO_ROOT, fp);
    if (WRITE) {
      fs.writeFileSync(fp, result.html);
      console.log(`  ✓ patched ${rel}`);
    } else {
      console.log(`  → would patch ${rel}`);
    }
  }

  console.log(`\nResult: patched=${patched}, skipped=${skipped}`);
  if (skipped > 0) {
    for (const [reason, count] of Object.entries(skipReasons)) {
      console.log(`  - ${reason}: ${count}`);
    }
  }
})();
