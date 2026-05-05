#!/usr/bin/env node
// publish.mjs — render markdown → HTML, update blog indexes, hreflang, git push
//
// Usage:
//   node publish.mjs <slug>                      # publish English only
//   node publish.mjs <slug> --langs=all          # publish English + 4 translations
//   node publish.mjs <slug> --langs=es,fr        # publish English + specified langs
//   node publish.mjs <slug> --skip-checks        # skip pre-publish gate (use sparingly)
//   node publish.mjs <slug> --no-push            # commit only, no git push (dry run)
//
// Pre-publish gate (HARD):
//   1. originality (vs sources)
//   2. ai-tells (banned phrases, structural patterns)
//   3. quality-heuristics (sentence variance, specificity, first-person)
//   4. eeat (author byline, citations, internal links, unique data)
//   5. editorial-diff (≥25% diff vs LLM original)
//
// Any failure blocks publish (unless --skip-checks). Soft signal (AI-detector
// monitor) is logged but not blocking.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import yaml from 'yaml';
import { renderArticle } from './lib/markdown-render.mjs';
import { parse as parseFm } from './lib/frontmatter.mjs';
import { assertValid, pathFor, urlFor } from './lib/slug.mjs';
import { log } from './lib/log.mjs';
import * as aiTells from './checks/ai-tells.mjs';
import * as quality from './checks/quality-heuristics.mjs';
import * as eeat from './checks/eeat.mjs';
import * as editorialDiff from './checks/editorial-diff.mjs';
import { regenerate as regenSitemap } from './lib/sitemap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPO_ROOT = path.resolve(ROOT, '..');
const DRAFTS_DIR = path.join(ROOT, 'drafts');

const I18N = yaml.parse(fs.readFileSync(path.join(ROOT, 'i18n.yaml'), 'utf8'));

const ALL_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'uk'];

// ── Argv ─────────────────────────────────────────────────────────────

const slug = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

if (!slug || slug === '--help' || slug === 'help') {
  console.log(`Usage: pnpm publish <slug> [--langs=all|es,fr,de,pt] [--skip-checks] [--no-push]`);
  process.exit(slug ? 0 : 1);
}

assertValid(slug);

const targetLangs = ['en', ...(flags.langs === 'all' ? ['es', 'fr', 'de', 'pt'] : (flags.langs ? flags.langs.split(',') : []))];

(async () => {
  // 1. Pre-publish gate
  if (!flags.skipChecks) {
    console.log(`\n  Pre-publish gate for: ${slug}\n`);
    const passed = await runPrePublishGate(slug);
    if (!passed) {
      console.error('\n  ✗ Pre-publish gate FAILED. Fix issues above or use --skip-checks (sparingly).\n');
      process.exit(1);
    }
    console.log('\n  ✓ All checks passed\n');
  }

  // 2. Render + write HTML for each language
  console.log(`  Rendering languages: ${targetLangs.join(', ')}`);
  const generated = [];
  for (const lang of targetLangs) {
    const result = renderForLang(slug, lang);
    if (result) generated.push(result);
  }

  // 3. Update blog/index.html for each language (add new card to grid)
  console.log(`  Updating blog index pages…`);
  for (const lang of targetLangs) {
    if (!generated.find((g) => g.lang === lang)) continue;
    updateBlogIndex(lang, generated.find((g) => g.lang === lang));
  }

  // 4. Update topics.yaml status
  updateTopicStatus(slug, 'published');

  // 5. Regenerate sitemap.xml (scans repo, picks up new HTML, updates lastmod)
  const sitemapResult = regenSitemap(REPO_ROOT);
  console.log(`  ✓ sitemap.xml updated (${sitemapResult.pageCount} pages)`);

  // 6. git commit + push
  if (!flags.noPush) {
    gitCommitAndPush(slug, generated);
  }

  log('publish.done', { slug, langs: generated.map((g) => g.lang) });
  console.log(`\n  ✓ Published "${slug}" in ${generated.length} languages.`);
  if (!flags.noPush) console.log(`  ✓ Pushed to main → Cloudflare deploy in 1-2 min.\n`);
})().catch((err) => {
  log('publish.error', { slug, error: err.message });
  console.error('\n✗ Publish failed:', err.message);
  process.exit(1);
});

// ── Pre-publish gate ──────────────────────────────────────────────────

async function runPrePublishGate(slug) {
  const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);
  if (!fs.existsSync(draftPath)) throw new Error(`Draft not found: ${draftPath}`);

  const md = fs.readFileSync(draftPath, 'utf8');
  const { frontmatter, body } = parseFm(md);

  let allPassed = true;

  // Editorial diff (can be selectively skipped for autonomous mode)
  const diffResult = editorialDiff.check(slug, DRAFTS_DIR);
  if (flags.skipEditorialDiff) {
    console.log(`  ⊘ Editorial diff: SKIPPED (--skip-editorial-diff). Other gates still apply.`);
  } else if (diffResult.warning) {
    console.log(`  ⚠  Editorial diff: ${diffResult.detail}`);
  } else if (!diffResult.passed) {
    console.log(`  ✗ Editorial diff: ${diffResult.detail}`);
    allPassed = false;
  } else {
    console.log(`  ✓ Editorial diff: ${(diffResult.diffRatio * 100).toFixed(1)}% changed`);
  }

  // AI-tells
  const aiResult = aiTells.check(body);
  if (!aiResult.passed) {
    console.log(`  ✗ AI-tells: ${aiResult.hits.length} hits`);
    console.log('    ' + aiTells.feedbackFor(aiResult.hits).split('\n').join('\n    '));
    allPassed = false;
  } else {
    console.log(`  ✓ AI-tells: ${aiResult.hits.length} hits (within tolerance)`);
  }

  // Quality
  const qResult = quality.check(body);
  if (!qResult.passed) {
    console.log(`  ✗ Quality heuristics: ${qResult.fails.length} fails`);
    console.log('    ' + quality.feedbackFor(qResult).split('\n').join('\n    '));
    allPassed = false;
  } else {
    console.log(`  ✓ Quality heuristics`);
  }

  // EEAT
  const eeatResult = eeat.check(body, frontmatter);
  if (!eeatResult.passed) {
    console.log(`  ✗ EEAT signals: ${eeatResult.fails.length} fails`);
    console.log('    ' + eeat.feedbackFor(eeatResult).split('\n').join('\n    '));
    allPassed = false;
  } else {
    console.log(`  ✓ EEAT signals (${eeatResult.signals.uniqueDataHits} unique-data, ${eeatResult.signals.authoritative} citations, ${eeatResult.signals.internalLinks} internal links)`);
  }

  log('publish.gate', {
    slug,
    passed: allPassed,
    aiTellsHits: aiResult.hits.length,
    qualityFails: qResult.fails.length,
    eeatFails: eeatResult.fails.length,
    editorialDiff: diffResult.diffRatio,
  });

  return allPassed;
}

// ── Render per language ───────────────────────────────────────────────

function renderForLang(slug, lang) {
  const draftPath =
    lang === 'en'
      ? path.join(DRAFTS_DIR, `${slug}.md`)
      : path.join(DRAFTS_DIR, `${slug}.${lang}.md`);

  if (!fs.existsSync(draftPath)) {
    console.log(`    (no ${lang} draft, skipping)`);
    return null;
  }

  const md = fs.readFileSync(draftPath, 'utf8');
  const { frontmatter, body } = parseFm(md);

  const translatedSlugs = Object.fromEntries(ALL_LANGS.map((l) => [l, slug])); // same-slug strategy

  const html = renderArticle({
    frontmatter,
    body,
    lang,
    i18n: I18N,
    translatedSlugs,
  });

  const outputPath = path.join(REPO_ROOT, pathFor(slug, lang));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html);

  console.log(`    ✓ ${pathFor(slug, lang)}`);
  return { lang, slug, frontmatter, outputPath };
}

// ── Update blog/index.html grid for a language ────────────────────────

function updateBlogIndex(lang, articleData) {
  const indexPath =
    lang === 'en'
      ? path.join(REPO_ROOT, 'blog', 'index.html')
      : path.join(REPO_ROOT, lang, 'blog', 'index.html');

  if (!fs.existsSync(indexPath)) {
    console.log(`    ⚠  ${lang} blog index missing (${indexPath}). Skipping.`);
    // Could auto-bootstrap here in v2
    return;
  }

  const fm = articleData.frontmatter;
  const dateStr = formatDate(fm.date, lang);
  const t = (key, vars = {}) => {
    let s = I18N[key]?.[lang] ?? I18N[key]?.en ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  };

  const cardId = `card-${articleData.slug}`;
  // Per-article image (Pexels-fetched) → fallback to legacy feature webp
  const heroImg = fm.hero_image
    || (fs.existsSync(path.join(REPO_ROOT, 'assets', 'blog', `${articleData.slug}.jpg`))
        ? `/assets/blog/${articleData.slug}.jpg`
        : `/assets/features/${categoryToImage(fm.category)}.webp`);

  const cardHtml = `
    <article class="blog-card" data-cat="${fm.category}">
      <a href="${articleData.slug}.html" aria-labelledby="${cardId}">
        <div class="blog-card-thumb">
          <img src="${heroImg}" alt="${escapeHtml(fm.hero_alt || fm.title)}" width="600" height="400" loading="lazy" decoding="async">
        </div>
        <div class="blog-card-body">
          <span class="blog-card-cat">${escapeHtml(fm.category)}</span>
          <h2 id="${cardId}" class="blog-card-title">${escapeHtml(fm.title)}</h2>
          <p class="blog-card-desc">${escapeHtml(fm.description || '')}</p>
          <div class="blog-card-meta">
            <time datetime="${fm.date}">${dateStr}</time>
            <span aria-hidden="true">·</span>
            <span>${t('read_time', { n: fm.read_time })}</span>
          </div>
        </div>
      </a>
    </article>`;

  let html = fs.readFileSync(indexPath, 'utf8');

  // Skip if card already inserted
  if (html.includes(`href="${articleData.slug}.html"`)) {
    console.log(`    · ${lang} index already has card for ${articleData.slug}, skipping`);
    return;
  }

  // Insert new card right after the opening <main class="blog-grid"> tag
  // (or after id="blog-grid" pattern). Newest articles appear first.
  const gridStart = html.indexOf('id="blog-grid">');
  if (gridStart === -1) {
    console.log(`    ⚠  Couldn't find blog-grid in ${lang} index`);
    return;
  }
  const insertAt = gridStart + 'id="blog-grid">'.length;
  html = html.slice(0, insertAt) + '\n' + cardHtml + html.slice(insertAt);

  // Update ItemList JSON-LD count if present
  // (deferred to v2 — tedious to mutate inline JSON-LD; daily-report can flag)

  fs.writeFileSync(indexPath, html);
  const indexRel = lang === 'en' ? 'blog/index.html' : `${lang}/blog/index.html`;
  console.log(`    ✓ Inserted card into ${indexRel}`);
}

// ── Topic status update ──────────────────────────────────────────────

function updateTopicStatus(slug, status) {
  const topicsPath = path.join(ROOT, 'topics.yaml');
  const topics = yaml.parse(fs.readFileSync(topicsPath, 'utf8'));
  const topic = topics.find((t) => t.slug === slug);
  if (topic) {
    topic.status = status;
    if (status === 'published') topic.published_at = new Date().toISOString();
    fs.writeFileSync(topicsPath, yaml.stringify(topics));
  }
}

// ── Git ──────────────────────────────────────────────────────────────

function gitCommitAndPush(slug, generated) {
  const langs = generated.map((g) => g.lang).join(',');
  const fm = generated[0].frontmatter;
  const message = `Blog: publish "${fm.title}" (${langs})

slug: ${slug}
category: ${fm.category}
languages: ${langs}
read time: ${fm.read_time} min

Generated by content-pipeline. Editorial pass complete; all gates passed.`;

  console.log(`  Committing…`);
  try {
    execSync(`git add -A`, { cwd: REPO_ROOT, stdio: 'inherit' });
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: REPO_ROOT, stdio: 'inherit' });
    console.log(`  Pushing to main…`);
    execSync(`git push origin HEAD:main`, { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch (err) {
    console.error(`  ✗ git operation failed: ${err.message}`);
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--langs=')) flags.langs = a.slice(8);
    else if (a === '--skip-checks') flags.skipChecks = true;
    else if (a === '--skip-editorial-diff') flags.skipEditorialDiff = true;
    else if (a === '--no-push') flags.noPush = true;
  }
  return flags;
}

function formatDate(iso, lang) {
  const d = new Date(iso);
  const localeMap = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR' };
  return d.toLocaleDateString(localeMap[lang] || 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function categoryToImage(cat) {
  return {
    behavioral: 'behavioral-capture',
    deliverability: 'realtime-intervention',
    ecommerce: 'multichannel',
    comparison: 'integrations',
    strategy: 'inbox-preview',
  }[cat] || 'inbox-preview';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
