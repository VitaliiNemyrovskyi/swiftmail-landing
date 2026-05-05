#!/usr/bin/env node
// news-fetch.mjs — pulls news topics from configured RSS sources,
// dedupes against existing topics.yaml, appends fresh ones as status:idea.
//
// Cron suggestion (4× daily, before 03:00 auto-publish):
//   0 */6 * * *  cd ~/swiftmail-landing/content-pipeline && \
//                node --env-file-if-exists=.env news-fetch.mjs >> logs/news.log 2>&1
//
// Manual:
//   pnpm news:fetch         fetch + append
//   pnpm news:fetch --dry   show what would be added, don't touch topics.yaml

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { harvest } from './lib/news.mjs';
import { log } from './lib/log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const TOPICS_PATH = path.join(ROOT, 'topics.yaml');
const NEWS_CONFIG_PATH = path.join(ROOT, 'news-sources.yaml');

const dryRun = process.argv.includes('--dry') || process.argv.includes('--dry-run');

(async () => {
  console.log(`\n  ⌘  News fetch — ${new Date().toISOString()}\n`);

  const config = yaml.parse(fs.readFileSync(NEWS_CONFIG_PATH, 'utf8'));
  console.log(`  ${config.rss_feeds.length} feeds configured`);

  const candidates = await harvest(config);
  console.log(`  ${candidates.length} candidate topics passed filters\n`);

  if (candidates.length === 0) {
    log('news.empty');
    console.log('  Nothing fresh today.\n');
    return;
  }

  // Load existing topics, dedupe by source_url and title
  const topics = yaml.parse(fs.readFileSync(TOPICS_PATH, 'utf8')) || [];
  const existingUrls = new Set(topics.map((t) => t.source_url).filter(Boolean));
  const existingTitles = new Set(
    topics.map((t) => (t.title || '').toLowerCase().slice(0, 80))
  );

  const fresh = candidates.filter((c) => {
    if (existingUrls.has(c.source_url)) return false;
    if (existingTitles.has((c.title || '').toLowerCase().slice(0, 80))) return false;
    return true;
  });

  if (fresh.length === 0) {
    log('news.no-new');
    console.log('  All candidates already in topics.yaml. Nothing to add.\n');
    return;
  }

  console.log(`  ${fresh.length} new topics to add:\n`);
  for (const t of fresh) {
    console.log(`    [score ${t.source_relevance_score}] ${t.title}`);
    console.log(`      slug:   ${t.slug}`);
    console.log(`      source: ${t.source_feed} → ${t.source_url}`);
    console.log();
  }

  if (dryRun) {
    console.log('  --dry-run: not touching topics.yaml.\n');
    return;
  }

  // Append to topics.yaml. We could be smart about ordering (insert
  // news at top) but simple append works — auto-publish picks by
  // status:idea + creation order or alternation logic.
  const updated = [...topics, ...fresh];
  fs.writeFileSync(TOPICS_PATH, yaml.stringify(updated));

  log('news.fetched', { added: fresh.length, slugs: fresh.map((t) => t.slug) });
  console.log(`  ✓ Appended ${fresh.length} news topics to topics.yaml\n`);
})().catch((err) => {
  log('news.error', { error: err.message });
  console.error('\n✗ news-fetch failed:', err.message);
  process.exit(1);
});
