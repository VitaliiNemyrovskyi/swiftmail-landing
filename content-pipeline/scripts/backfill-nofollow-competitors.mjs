#!/usr/bin/env node
// backfill-nofollow-competitors.mjs — add `rel="nofollow"` to existing
// outbound links pointing at SwiftMail's direct competitors. Runs
// across blog/*.html plus all locale folders. Idempotent.
//
// Why: pre-2026-05-10 the renderer emitted `rel="noopener"` on every
// outbound link, including links to klaviyo.com / mailchimp.com /
// activecampaign.com etc. Each one passes SEO link-juice to a
// competitor. Going forward the renderer adds nofollow automatically
// (see lib/markdown-render.mjs); this script does the one-time
// retroactive cleanup of the 35+ already-published articles.
//
// Usage:
//   node content-pipeline/scripts/backfill-nofollow-competitors.mjs           # dry-run
//   node content-pipeline/scripts/backfill-nofollow-competitors.mjs --write   # apply
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');

const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'uk'];

// Keep in sync with COMPETITOR_DOMAINS in lib/markdown-render.mjs.
const COMPETITOR_DOMAINS = [
  'klaviyo.com',
  'mailchimp.com',
  'activecampaign.com',
  'customer.io',
  'drip.com',
  'omnisend.com',
  'brevo.com',
  'mailerlite.com',
  'encharge.io',
  'bloomreach.com',
  'contentsquare.com',
  'hotjar.com',
  'mouseflow.com',
];

function isCompetitor(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  return COMPETITOR_DOMAINS.some((d) => url.includes(d));
}

/** Patch one HTML string. Returns { html, changes }. */
function patchHtml(html) {
  let changes = 0;
  // Match every <a ...href="https?://..." ...> tag. Re-emit the same
  // tag with `rel="nofollow noopener"` if href is a competitor and
  // the rel doesn't already include `nofollow`.
  const out = html.replace(
    /<a\s+([^>]*?\bhref="(https?:\/\/[^"]+)"[^>]*?)>/g,
    (full, attrs, href) => {
      if (!isCompetitor(href)) return full;
      // Already has nofollow — idempotent skip.
      if (/\brel="[^"]*nofollow[^"]*"/.test(attrs)) return full;

      let newAttrs;
      if (/\brel="([^"]*)"/.test(attrs)) {
        // Has rel — extend it.
        newAttrs = attrs.replace(/\brel="([^"]*)"/, (_, prev) => {
          const tokens = new Set(prev.trim().split(/\s+/).filter(Boolean));
          tokens.add('nofollow');
          tokens.add('noopener');
          return `rel="${[...tokens].join(' ')}"`;
        });
      } else {
        // No rel — add one (place near href for readability).
        newAttrs = attrs.replace(
          /(\bhref="[^"]+")/,
          '$1 rel="nofollow noopener"',
        );
      }
      changes += 1;
      return `<a ${newAttrs}>`;
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
  let totalChanges = 0;
  for (const fp of files) {
    const html = fs.readFileSync(fp, 'utf8');
    const { html: out, changes } = patchHtml(html);
    if (changes === 0) continue;
    totalFiles += 1;
    totalChanges += changes;
    const rel = path.relative(REPO_ROOT, fp);
    if (WRITE) {
      fs.writeFileSync(fp, out);
      console.log(`  ✓ ${rel} — ${changes} link(s) flagged nofollow`);
    } else {
      console.log(`  → ${rel} — would flag ${changes} link(s)`);
    }
  }
  console.log(`\nResult: files=${totalFiles}, links=${totalChanges}`);
})();
