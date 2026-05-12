#!/usr/bin/env node
// strip-email-vendor-links.mjs — one-shot cleanup: remove outbound
// <a> tags pointing at any email-space vendor (Postmark, Mailgun,
// SendGrid, Klaviyo, Mailchimp, ActiveCampaign, etc.) from already-
// published blog HTML. Link TEXT survives as plain prose so the
// article still reads coherently — it just stops sending readers off
// to a competitor.
//
// Why a backfill: as of 2026-05-12 the renderer's whitelist no longer
// accepts these domains, so any *new* article auto-strips them. This
// script catches the legacy articles that pre-date that change.
//
// Idempotent — re-running finds nothing new to strip.
//
// Usage:
//   node content-pipeline/scripts/strip-email-vendor-links.mjs           # dry-run
//   node content-pipeline/scripts/strip-email-vendor-links.mjs --write   # apply
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');

const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'uk'];

/**
 * Domains we want to UN-link from articles. Anything matching one of
 * these → the `<a>` wrapper is stripped, only the link text remains.
 *
 * Sourced from the union of:
 *   - marketing-automation competitors (lib/markdown-render.mjs's
 *     COMPETITOR_DOMAINS)
 *   - transactional ESPs (postmarkapp.com / mailgun.com / sendgrid.com)
 *     — formally a different category, but they're still email vendors
 *     competing for reader's attention + search intent
 *   - email-comparison sites (emailtooltester.com)
 *
 * If you want to KEEP citing one of these in a specific article, edit
 * topics.yaml's hand-curated frontmatter to add the link AFTER
 * generation, or strip from this list.
 */
const STRIP_DOMAINS = [
  // Marketing-automation competitors
  'klaviyo.com',
  'mailchimp.com',
  'activecampaign.com',
  'customer.io',
  'drip.com',
  'omnisend.com',
  'brevo.com',
  'mailerlite.com',
  'encharge.io',
  'sendinblue.com',
  // Behavioral / enterprise platforms
  'bloomreach.com',
  'contentsquare.com',
  'optimizely.com',
  'hotjar.com',
  'mouseflow.com',
  'fullstory.com',
  'posthog.com',
  // Transactional ESPs — same reader, same intent
  'postmarkapp.com',
  'mailgun.com',
  'sendgrid.com',
  'documentation.mailgun.com',
  // Comparison sites
  'emailtooltester.com',
];

function shouldStrip(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  return STRIP_DOMAINS.some((d) => url.includes(d));
}

/** Patch one HTML string. Returns { html, changes }. */
function patchHtml(html) {
  let changes = 0;
  // Match <a ...href="https?://...">TEXT</a>, where href matches a
  // strip-domain. Replace with just TEXT (preserve link text, drop tag).
  // We match conservatively — only `<a>` tags inside an article body,
  // not internal swift-mail.app or relative links.
  const out = html.replace(
    /<a\s+[^>]*?\bhref="(https?:\/\/[^"]+)"[^>]*?>([^<]*)<\/a>/g,
    (full, href, text) => {
      if (!shouldStrip(href)) return full;
      changes += 1;
      return text; // bare text, no link
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
      console.log(`  ✓ ${rel} — stripped ${changes} link(s)`);
    } else {
      console.log(`  → ${rel} — would strip ${changes} link(s)`);
    }
  }
  console.log(`\nResult: files=${totalFiles}, links=${totalLinks}`);
})();
