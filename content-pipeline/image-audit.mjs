#!/usr/bin/env node
// image-audit.mjs — fetch unique relevant images for ALL existing blog
// articles. Reads blog/*.html, derives slug + category + keyword from
// frontmatter / topics.yaml, queries Pexels, downloads to /assets/blog/.
//
// Then updates each article HTML + blog/index.html to point at the new
// image instead of the reused /assets/features/* file.
//
// Usage:
//   pnpm image:audit              # fetch missing images
//   pnpm image:audit --force      # re-fetch even if /assets/blog/<slug>.jpg exists
//   pnpm image:audit --dry        # show what would be fetched, no API calls

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { fetchOne, buildQuery } from './lib/images.mjs';
import { log } from './lib/log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, '..');
const BLOG_DIR = path.join(REPO_ROOT, 'blog');
const BLOG_IMAGES_DIR = path.join(REPO_ROOT, 'assets', 'blog');

const flags = {
  force: process.argv.includes('--force'),
  dry: process.argv.includes('--dry') || process.argv.includes('--dry-run'),
};

(async () => {
  if (!process.env.PEXELS_API_KEY && !flags.dry) {
    console.error(`✗ PEXELS_API_KEY missing. Get one at https://www.pexels.com/api/ and add to .env`);
    process.exit(1);
  }

  console.log(`\n  ⌘  Image audit — ${flags.dry ? 'DRY-RUN' : 'live fetch'}\n`);

  const topics = yaml.parse(fs.readFileSync(path.join(ROOT, 'topics.yaml'), 'utf8'));
  const topicMap = Object.fromEntries(topics.map((t) => [t.slug, t]));

  // Discover articles by scanning blog/*.html
  const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.html') && f !== 'index.html');

  console.log(`  Found ${files.length} articles in /blog/\n`);

  const stats = { fetched: 0, skipped: 0, failed: 0 };
  const updates = [];

  for (const file of files) {
    const slug = file.replace(/\.html$/, '');
    const imgPath = path.join(BLOG_IMAGES_DIR, `${slug}.jpg`);

    if (fs.existsSync(imgPath) && !flags.force) {
      stats.skipped++;
      continue;
    }

    // Derive search query from topic metadata if available, else from HTML title
    let topic = topicMap[slug];
    if (!topic) {
      const html = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
      const title = (html.match(/<title>([^<]+)<\/title>/) || [, slug])[1].replace(/ — SwiftMail$/, '');
      const cat = (html.match(/class="blog-category"[^>]*>([^<]+)/) || [, 'strategy'])[1].toLowerCase();
      topic = { slug, title, category: normalizeCategory(cat), target_keyword: title.slice(0, 60) };
    }

    const query = buildQuery(topic);
    console.log(`  → ${slug}`);
    console.log(`    query: "${query}"`);

    if (flags.dry) {
      stats.fetched++;
      continue;
    }

    try {
      const result = await fetchOne({ slug, query });
      if (!result) {
        console.log(`    ✗ no results for "${query}"`);
        stats.failed++;
        continue;
      }
      console.log(`    ✓ ${result.bytes / 1024 | 0}KB · photographer: ${result.photographer}`);
      stats.fetched++;
      updates.push({ slug, alt: result.alt, photographer: result.photographer });
      // Pexels rate limit: 200 req/hr → throttle to ~1 req per 20s in batch
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
      stats.failed++;
      log('image-audit.error', { slug, query, error: err.message });
    }
  }

  console.log(`\n  ✓ ${stats.fetched} fetched, ${stats.skipped} skipped, ${stats.failed} failed`);

  if (updates.length > 0 && !flags.dry) {
    console.log(`\n  → Updating HTML to use /assets/blog/<slug>.jpg…`);
    rewriteBlogIndex(updates);
    rewriteArticlePages(updates);
    console.log(`  ✓ HTML updated`);
  }

  log('image-audit.done', stats);
})().catch((err) => {
  console.error('\n✗ image-audit failed:', err.message);
  process.exit(1);
});

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeCategory(raw) {
  const s = raw.toLowerCase();
  if (/(deliverab|spam|dkim|spf|dmarc|bimi)/.test(s)) return 'deliverability';
  if (/(behavior|ai|attribution|signal|journey)/.test(s)) return 'behavioral';
  if (/(ecommerce|shopify|cart|automation)/.test(s)) return 'ecommerce';
  if (/(comparison|migration|alternative)/.test(s)) return 'comparison';
  return 'strategy';
}

/**
 * Update blog/index.html — for each updated slug, replace
 * src="/assets/features/<old>.webp" with src="/assets/blog/<slug>.jpg".
 * Also update alt text if Pexels gave us a better one.
 */
function rewriteBlogIndex(updates) {
  const indexPath = path.join(BLOG_DIR, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  for (const u of updates) {
    // Find article block with href="<slug>.html" and replace its img src
    const articleRe = new RegExp(
      `(<article class="blog-card"[^>]*>\\s*<a href="${u.slug}\\.html"[\\s\\S]*?<div class="blog-card-thumb">\\s*<img\\s+src=")[^"]+("[^>]*alt=")[^"]*("[^>]*>)`,
      'm'
    );
    if (articleRe.test(html)) {
      html = html.replace(articleRe, (m, p1, p2, p3) => {
        return `${p1}/assets/blog/${u.slug}.jpg${p2}${escapeHtml(u.alt)}${p3}`;
      });
    }

    // Also handle the featured card if it matches this slug
    const featuredRe = new RegExp(
      `(<article class="blog-featured-card"[^>]*>\\s*<a href="${u.slug}\\.html"[\\s\\S]*?<img\\s+src=")[^"]+("[^>]*alt=")[^"]*("[^>]*>)`,
      'm'
    );
    if (featuredRe.test(html)) {
      html = html.replace(featuredRe, (m, p1, p2, p3) => `${p1}/assets/blog/${u.slug}.jpg${p2}${escapeHtml(u.alt)}${p3}`);
    }
  }

  fs.writeFileSync(indexPath, html);
}

/**
 * Update individual blog post HTML files to use the new image.
 * The blog post template wraps the hero image in either <figure class="blog-hero-img">
 * or <div class="blog-hero-img"> — match both. Also rewrites the og:image meta tag
 * if it currently points at any non-/assets/blog/ URL (e.g. Unsplash).
 */
function rewriteArticlePages(updates) {
  for (const u of updates) {
    const articlePath = path.join(BLOG_DIR, `${u.slug}.html`);
    if (!fs.existsSync(articlePath)) continue;
    let html = fs.readFileSync(articlePath, 'utf8');
    let changed = false;

    // Hero <img> inside <figure|div class="blog-hero-img">
    const heroRe = /(<(?:figure|div) class="blog-hero-img">\s*<img\s+src=")[^"]+("[^>]*alt=")[^"]*("[^>]*>)/;
    if (heroRe.test(html)) {
      html = html.replace(heroRe, (m, p1, p2, p3) => `${p1}/assets/blog/${u.slug}.jpg${p2}${escapeHtml(u.alt)}${p3}`);
      changed = true;
    }

    // og:image (only rewrite if it's pointing at a hosted image, not already at /assets/blog/)
    const ogRe = /(<meta\s+property="og:image"\s+content=")[^"]+(")/;
    const ogMatch = html.match(ogRe);
    if (ogMatch && !ogMatch[0].includes('/assets/blog/')) {
      html = html.replace(ogRe, `$1https://swift-mail.app/assets/blog/${u.slug}.jpg$2`);
      changed = true;
    }

    if (changed) fs.writeFileSync(articlePath, html);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
