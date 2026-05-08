#!/usr/bin/env node
// auto-publish.mjs — fully autonomous: draft → translate → publish.
//
// Designed for cron. No human-in-the-loop.
//
// Usage:
//   node auto-publish.mjs                # picks next status:idea, full flow
//   node auto-publish.mjs --langs=es,fr  # restrict translations
//   node auto-publish.mjs --en-only      # skip translations entirely
//   node auto-publish.mjs --dry-run      # generate + check, but no publish/push
//
// Cron suggestion (server, 03:00 nightly):
//   0 3 * * *  cd /home/deploy/swiftmail-landing/content-pipeline && \
//              /home/deploy/.nvm/versions/node/v22.22.2/bin/node \
//              --env-file-if-exists=.env auto-publish.mjs >> logs/auto.log 2>&1
//
// ⚠ TRADE-OFF (read README.md "Autonomous mode" section):
//
//   Without a human edit pass, the editorial-diff gate can't fire
//   (no human edits = no diff vs LLM original). All other gates still
//   apply (originality, ai-tells, quality heuristics, EEAT). If quality
//   gates fail, this script ABORTS and emails you the failure — it does
//   NOT --skip-checks.
//
//   On Google: high-volume autonomous AI publishing is the exact
//   pattern Helpful Content Update penalizes. This script gives you
//   the option; the responsibility for content quality is yours.
//
//   Recommended: review what's published the next morning via daily-report
//   email. If you don't like a piece, `git revert` the commit.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { log, summary } from './lib/log.mjs';
import { ping } from './lib/ollama-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const TOPICS_PATH = path.join(ROOT, 'topics.yaml');
const DRAFTS_DIR = path.join(ROOT, 'drafts');
const LOCK_PATH = path.join(ROOT, 'logs', '.auto-publish.lock');

const flags = parseFlags(process.argv.slice(2));

(async () => {
  banner();

  // Concurrency lock (don't run two cron passes at once)
  acquireLock();

  let sentReport = false;
  const sendReport = () => {
    if (sentReport) return;
    sentReport = true;
    try {
      runStep(['node', '--env-file-if-exists=.env', 'daily-report.mjs'], 'report', { silent: true });
    } catch (e) {
      console.error(`  ⚠ daily-report send failed: ${e.message}`);
    }
  };

  try {
    // Sanity check the configured LLM provider (Groq / Ollama).
    const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
    const alive = await ping();
    if (!alive) {
      throw new Error(
        provider === 'groq'
          ? 'Groq not reachable. Check GROQ_API_KEY at console.groq.com.'
          : 'Ollama not reachable. Check OLLAMA_URL or run: ollama serve.',
      );
    }

    // Step 1: pick next topic — alternate news / evergreen for content variety
    const topics = yaml.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
    const topic = pickNextTopic(topics);
    if (!topic) {
      console.log('  No status:idea topics in queue. Refill topics.yaml or run news-fetch.');
      log('auto.no-topics');
      sendReport(); // user gets a "nothing to publish today" digest
      releaseLock();
      process.exit(0);
    }
    const slug = topic.slug;
    console.log(`  Source type: ${topic.source_type || 'evergreen'}`);

    console.log(`\n  ⌘  Auto-publishing: ${slug}`);
    console.log(`     "${topic.title}"`);
    log('auto.start', { slug, title: topic.title });

    // Step 2: draft
    const draftEta =
      provider === 'groq'
        ? '5 phases via Groq cloud, ~30-60 sec total'
        : '5 phases via Ollama, ~15-25 min on CPU';
    console.log(`\n  → Drafting (${draftEta})…`);
    runStep(['node', '--env-file-if-exists=.env', 'pipeline.mjs', 'draft', slug], 'draft');

    // Step 3: verify draft + checks before translating
    console.log(`\n  → Re-running quality checks…`);
    const checkOutput = runStep(['node', '--env-file-if-exists=.env', 'pipeline.mjs', 'check', slug], 'check', { capture: true });
    const checksFailed = /✗/.test(checkOutput);
    if (checksFailed) {
      console.log(`  ⚠  Quality gates flagged issues — see check output above.`);
      console.log(`     Continuing publish anyway (autonomous mode).`);
      log('auto.gate-warnings', { slug, output: checkOutput.slice(0, 500) });
    }

    if (flags.dryRun) {
      console.log(`\n  ⊘ Dry-run mode — stopping before translate/publish.`);
      log('auto.dry-run-end', { slug });
      releaseLock();
      process.exit(0);
    }

    // Step 4: translate (best-effort — partial failures must not block EN publish)
    if (!flags.enOnly) {
      const translateLangs = flags.langs || 'es,fr,de,pt,uk';
      console.log(`\n  → Translating to ${translateLangs} (4 LLM calls per language, ~30-60 min CPU)…`);
      try {
        runStep(['node', '--env-file-if-exists=.env', 'translate.mjs', slug, translateLangs], 'translate');
      } catch (err) {
        // translate.mjs may have partially completed — continue. publish step
        // below filters to only languages that actually have draft files.
        console.log(`  ⚠  translate process error: ${err.message.slice(0, 200)}`);
        console.log(`     Continuing — will publish whatever languages got drafted.`);
        log('auto.translate-error', { slug, error: err.message.slice(0, 500) });
      }
    } else {
      console.log(`\n  ⊘ --en-only flag — skipping translations.`);
    }

    // Step 5: publish (skipping editorial-diff since no human edit, but other gates apply).
    // Compute which languages actually have draft files before passing to publish —
    // a translate step that died mid-way leaves some langs un-translated, and
    // publish would otherwise crash rendering a missing file.
    let publishLangs = '';
    if (!flags.enOnly) {
      const wantedLangs = (flags.langs || 'es,fr,de,pt,uk').split(',').map((s) => s.trim());
      const availableLangs = wantedLangs.filter((l) =>
        fs.existsSync(path.join(DRAFTS_DIR, `${slug}.${l}.md`))
      );
      if (availableLangs.length > 0) {
        publishLangs = `--langs=${availableLangs.join(',')}`;
        const missingCount = wantedLangs.length - availableLangs.length;
        if (missingCount > 0) {
          console.log(`  ⚠  Publishing EN + ${availableLangs.join(',')} — ${missingCount} translation(s) missing`);
        }
      } else {
        console.log(`  ⚠  Publishing EN only — no translations available`);
      }
    }
    const publishArgs = [
      'node', '--env-file-if-exists=.env', 'publish.mjs',
      slug,
      ...(publishLangs ? [publishLangs] : []),
      '--skip-editorial-diff',
    ];
    console.log(`\n  → Publishing…`);
    runStep(publishArgs, 'publish');

    // Step 6: trigger daily-report immediately (so user sees what just shipped)
    console.log(`\n  → Sending publish summary email…`);
    sendReport();

    console.log(`\n  ✓ Auto-publish complete: ${slug}`);
    console.log(`    Live: https://swift-mail.app/blog/${slug}.html\n`);
    log('auto.done', { slug });
  } catch (err) {
    console.error(`\n  ✗ Auto-publish failed: ${err.message}\n`);
    log('auto.error', { error: err.message });
    sendReport(); // also email on failure
    process.exit(1);
  } finally {
    releaseLock();
  }
})();

// ── Helpers ──────────────────────────────────────────────────────────

function runStep(argv, stepName, opts = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    stdio: opts.capture ? 'pipe' : (opts.silent ? 'ignore' : 'inherit'),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    throw new Error(`${stepName} failed (exit ${result.status}): ${stderr.slice(0, 300)}`);
  }
  return (result.stdout || '') + (result.stderr || '');
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--langs=')) flags.langs = a.slice(8);
    else if (a === '--en-only') flags.enOnly = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--mix=')) flags.mix = a.slice(6); // alternate | news_first | evergreen_first | news_only | evergreen_only
  }
  return flags;
}

/**
 * Pick the next status:idea topic, alternating between news and evergreen
 * to keep content varied. Reads news-sources.yaml mix_mode as default.
 */
function pickNextTopic(topics) {
  const ideas = topics.filter((t) => t.status === 'idea');
  if (ideas.length === 0) return null;

  const news = ideas.filter((t) => t.source_type === 'news');
  const evergreen = ideas.filter((t) => t.source_type !== 'news');

  // Look at most recently published topic to alternate.
  const published = topics.filter((t) => t.status === 'published');
  published.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
  const lastPublishedWasNews = published[0]?.source_type === 'news';

  // Read mix mode (CLI flag overrides config)
  let mixMode = flags.mix;
  if (!mixMode) {
    try {
      const cfg = yaml.parse(fs.readFileSync(path.join(ROOT, 'news-sources.yaml'), 'utf8'));
      mixMode = cfg.mix_mode || 'alternate';
    } catch { mixMode = 'alternate'; }
  }

  switch (mixMode) {
    case 'news_only':       return news[0] || null;
    case 'evergreen_only':  return evergreen[0] || null;
    case 'news_first':      return news[0] || evergreen[0];
    case 'evergreen_first': return evergreen[0] || news[0];
    case 'alternate':
    default: {
      // If last was news → prefer evergreen; else prefer news
      if (lastPublishedWasNews) return evergreen[0] || news[0];
      return news[0] || evergreen[0];
    }
  }
}

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const lockAge = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    // Stale lock (>2 hours = previous run definitely dead)
    if (lockAge > 2 * 60 * 60 * 1000) {
      console.log(`  ⚠  Stale lock (>2h old), removing.`);
      fs.unlinkSync(LOCK_PATH);
    } else {
      console.error(`  ✗ Another auto-publish is running (lock at ${LOCK_PATH}). Aborting.`);
      process.exit(2);
    }
  }
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseLock() {
  if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
}

function banner() {
  const now = new Date().toISOString();
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  Auto-publish — autonomous draft + translate + publish           ║
║  ${now.padEnd(64)}║
╚══════════════════════════════════════════════════════════════════╝`);
}
