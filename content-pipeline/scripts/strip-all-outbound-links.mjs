#!/usr/bin/env node
// strip-all-outbound-links.mjs — remove EVERY outbound `<a>` tag from
// existing blog HTML files. After 2026-05-12 the renderer doesn't
// emit them at all (RENDERER_OUTBOUND_WHITELIST is empty); this is the
// one-shot retroactive cleanup for the 38 articles already in git.
//
// What survives: link text, as plain prose. Internal swift-mail.app
// links and relative URLs are untouched.
//
// Idempotent.
//
// Usage:
//   node content-pipeline/scripts/strip-all-outbound-links.mjs           # dry-run
//   node content-pipeline/scripts/strip-all-outbound-links.mjs --write   # apply
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');

const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'uk'];

/**
 * Should this URL keep its `<a>` wrapper? Only if it's clearly
 * internal — same domain (swift-mail.app) or a relative path.
 * Everything else gets stripped to plain text.
 */
function isInternalKeep(url) {
  if (!url) return false;
  if (url.startsWith('/') || url.startsWith('#') || url.startsWith('mailto:')) return true;
  if (/^https?:\/\/(www\.)?swift-mail\.app(\/|$)/.test(url)) return true;
  return false;
}

function patchHtml(html) {
  let changes = 0;
  // Strip `<a href="...">text</a>` where href is not internal.
  // We deliberately operate over the entire HTML (not just the
  // article body) — but since the only outbound `<a>` tags in our
  // files are inside .blog-content, this is safe.
  //
  // We also need to preserve `<link rel="alternate" hreflang="...">`
  // tags in the <head> — those are <link>, not <a>, so the regex
  // below (`<a ...>...`) naturally skips them.
  const out = html.replace(
    /<a\s+([^>]*?\bhref="([^"]+)"[^>]*?)>([^<]*)<\/a>/g,
    (full, _attrs, href, text) => {
      if (isInternalKeep(href)) return full;
      changes += 1;
      return text;
    },
  );
  return { html: out, changes };
}

function gatherFiles() {
  const out = [];
  for (const lang of LANGS) {
    const dir = lang === 'en' ? path.join(REPO_ROOT, 'blog') : path.join(REPO_ROOT, lang, 'blog');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.html') || f === 'index.html') continue;
      out.push(path.join(dir, f));
    }
  }
  return out;
}

(function main() {
  const files = gatherFiles();
  console.log(`scanning ${files.length} files (${WRITE ? 'WRITE mode' : 'dry-run; pass --write to apply'})\n`);

  let totalFiles = 0;
  let totalLinks = 0;
  for (const fp of files) {
    const html = fs.readFileSync(fp, 'utf8');
    const { html: out, changes } = patchHtml(html);
    if (changes === 0) continue;
    totalFiles += 1;
    totalLinks += changes;
    const rel = path.relative(REPO_ROOT, fp);
    if (WRITE) {
      fs.writeFileSync(fp, out);
      console.log(`  ✓ ${rel} — stripped ${changes} outbound link(s)`);
    } else {
      console.log(`  → ${rel} — would strip ${changes} outbound link(s)`);
    }
  }
  console.log(`\nResult: files=${totalFiles}, links=${totalLinks}`);
})();
