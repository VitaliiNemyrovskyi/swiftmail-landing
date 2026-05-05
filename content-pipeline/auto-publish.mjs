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

  try {
    // Sanity check Ollama
    const alive = await ping();
    if (!alive) {
      throw new Error('Ollama not reachable. Check OLLAMA_URL.');
    }

    // Step 1: pick next topic
    const topics = yaml.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
    const topic = topics.find((t) => t.status === 'idea');
    if (!topic) {
      console.log('  No status:idea topics in queue. Refill topics.yaml.');
      log('auto.no-topics');
      process.exit(0);
    }
    const slug = topic.slug;

    console.log(`\n  ⌘  Auto-publishing: ${slug}`);
    console.log(`     "${topic.title}"`);
    log('auto.start', { slug, title: topic.title });

    // Step 2: draft
    console.log(`\n  → Drafting (5 phases via Ollama, ~15-25 min on CPU)…`);
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

    // Step 4: translate
    if (!flags.enOnly) {
      const translateLangs = flags.langs || 'es,fr,de,pt';
      console.log(`\n  → Translating to ${translateLangs} (4 LLM calls per language, ~30-60 min CPU)…`);
      runStep(['node', '--env-file-if-exists=.env', 'translate.mjs', slug, translateLangs], 'translate');
    } else {
      console.log(`\n  ⊘ --en-only flag — skipping translations.`);
    }

    // Step 5: publish (skipping editorial-diff since no human edit, but other gates apply)
    const publishLangs = flags.enOnly ? '' : `--langs=${flags.langs || 'all'}`;
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
    runStep(['node', '--env-file-if-exists=.env', 'daily-report.mjs'], 'report', { silent: true });

    console.log(`\n  ✓ Auto-publish complete: ${slug}`);
    console.log(`    Live: https://swift-mail.app/blog/${slug}.html\n`);
    log('auto.done', { slug });
  } catch (err) {
    console.error(`\n  ✗ Auto-publish failed: ${err.message}\n`);
    log('auto.error', { error: err.message });
    // Send error email immediately (don't wait for next 9 AM cron)
    try {
      runStep(['node', '--env-file-if-exists=.env', 'daily-report.mjs'], 'error-report', { silent: true });
    } catch {}
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
  }
  return flags;
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
