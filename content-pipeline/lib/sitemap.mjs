// Sitemap generator. Scans the repo for live HTML pages, emits
// sitemap.xml with current lastmod dates.
//
// Usage:
//   import { regenerate } from './lib/sitemap.mjs';
//   regenerate('/path/to/repo-root');  // writes <root>/sitemap.xml

import fs from 'node:fs';
import path from 'node:path';

const SITE = 'https://swift-mail.app';
const LANGS = ['en', 'es', 'fr', 'de', 'pt'];

// Priority by URL pattern. Tuned for SEO weight Google's already learned.
function priority(relPath) {
  if (relPath === '' || relPath === 'index.html') return 1.0;
  if (/^[a-z]{2}\/index\.html$/.test(relPath)) return 0.9;        // /es/index.html etc
  if (relPath === 'features/index.html') return 0.95;
  if (/^features\/[^/]+\/index\.html$/.test(relPath)) return 0.85;
  if (/^[a-z]{2}\/features\/(?:index|[^/]+\/index)\.html$/.test(relPath)) return 0.7;
  if (relPath === 'blog/index.html') return 0.85;
  if (/^blog\/[^/]+\.html$/.test(relPath)) return 0.8;
  if (/^[a-z]{2}\/blog\/(?:index\.html|[^/]+\.html)$/.test(relPath)) return 0.7;
  if (relPath === 'privacy.html' || relPath === 'terms.html') return 0.3;
  return 0.5;
}

// Skip noindex / admin / internal files
const SKIP_PATTERNS = [
  /^admin\.html$/,
  /^content-pipeline\//,
  /^\./,
  /^node_modules\//,
  /\.original\.html$/,
  /^demo-assets\//,
  /^assets\//,
  /^css\//,
  /^js\//,
  /^fonts\//,
  /^blog\/test-/,
];

function shouldSkip(relPath) {
  return SKIP_PATTERNS.some((re) => re.test(relPath));
}

/**
 * Convert filesystem path → URL path (handle clean URLs, /index.html → /)
 */
function urlForPath(relPath) {
  // /blog/index.html → /blog/
  // /features/integrations/index.html → /features/integrations/
  // /es/index.html → /es/
  // /privacy.html → /privacy.html  (legal pages keep .html for canonical consistency)
  // /blog/some-article.html → /blog/some-article.html
  if (relPath === 'index.html') return SITE + '/';
  if (relPath.endsWith('/index.html')) {
    return SITE + '/' + relPath.replace(/index\.html$/, '');
  }
  return SITE + '/' + relPath;
}

/**
 * Walk repo root, collect HTML pages, sorted by priority desc then path.
 */
function collectPages(repoRoot) {
  const pages = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, ent.name);
      const relPath = path.relative(repoRoot, fullPath);
      if (ent.isDirectory()) {
        if (!shouldSkip(relPath + '/')) walk(fullPath);
      } else if (ent.name.endsWith('.html') && !shouldSkip(relPath)) {
        const stat = fs.statSync(fullPath);
        const lastmod = stat.mtime.toISOString().slice(0, 10);
        pages.push({
          relPath,
          url: urlForPath(relPath),
          lastmod,
          priority: priority(relPath),
        });
      }
    }
  }
  walk(repoRoot);
  // Sort: priority desc, then path
  pages.sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));
  return pages;
}

/**
 * Generate sitemap.xml content.
 */
function generateXml(pages) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const p of pages) {
    lines.push(
      `  <url><loc>${p.url}</loc><lastmod>${p.lastmod}</lastmod><priority>${p.priority.toFixed(2)}</priority></url>`
    );
  }
  lines.push('</urlset>');
  lines.push('');
  return lines.join('\n');
}

/**
 * Regenerate sitemap.xml at repo root. Returns { pageCount, path }.
 */
export function regenerate(repoRoot) {
  const pages = collectPages(repoRoot);
  const xml = generateXml(pages);
  const outPath = path.join(repoRoot, 'sitemap.xml');
  fs.writeFileSync(outPath, xml);
  return { pageCount: pages.length, path: outPath };
}
