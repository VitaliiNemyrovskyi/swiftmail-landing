#!/usr/bin/env node
// pipeline.mjs — main draft generator
//
// Usage:
//   node pipeline.mjs draft <slug>        # picks topic from topics.yaml, generates draft
//   node pipeline.mjs draft-next          # picks next status:idea topic, drafts it
//   node pipeline.mjs check <slug>        # re-runs all checks on existing draft
//   node pipeline.mjs status              # show backlog summary
//
// Multi-pass:
//   1. RESEARCH — read sources_hint, extract facts (LLM)
//   2. OUTLINE — propose unique structure (LLM)
//   3. DRAFT — write body using voice.md + humanizer.md + facts (LLM)
//   4. STYLE-ALIGN — second pass to fix AI-tells caught by checks/ai-tells (LLM)
//   5. SEO PASS — meta description, internal-link suggestions (LLM)
//
// Each LLM call is logged to logs/pipeline-YYYY-MM-DD.jsonl for daily-report.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { complete, ping, listModels } from './lib/ollama-client.mjs';
import { slugify, assertValid } from './lib/slug.mjs';
import { serialize as serializeFm, parse as parseFm, assertFields } from './lib/frontmatter.mjs';
import { log } from './lib/log.mjs';
import * as aiTells from './checks/ai-tells.mjs';
import * as quality from './checks/quality-heuristics.mjs';
import * as eeat from './checks/eeat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const VOICE_MD = fs.readFileSync(path.join(ROOT, 'voice.md'), 'utf8');
const HUMANIZER_MD = fs.readFileSync(path.join(ROOT, 'humanizer.md'), 'utf8');
const PRODUCT_CTX = fs.readFileSync(path.join(ROOT, 'product-context.md'), 'utf8');

const TOPICS_PATH = path.join(ROOT, 'topics.yaml');
const DRAFTS_DIR = path.join(ROOT, 'drafts');

if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

// ── Top-level commands ────────────────────────────────────────────────

const cmd = process.argv[2];
const arg = process.argv[3];

const CMDS_NEEDING_OLLAMA = new Set(['draft', 'draft-next']);

(async () => {
  // Sanity check Ollama is reachable
  if (cmd && CMDS_NEEDING_OLLAMA.has(cmd)) {
    const alive = await ping();
    if (!alive) {
      console.error(`✗ Ollama not reachable at ${process.env.OLLAMA_URL || 'http://localhost:11434'}`);
      console.error('  Set OLLAMA_URL env var, or run: ollama serve');
      process.exit(1);
    }
    const models = await listModels();
    const target = process.env.OLLAMA_MODEL || 'llama3.3:70b';
    if (!models.find((m) => m.name === target)) {
      console.error(`✗ Model "${target}" not loaded.  Available: ${models.map((m) => m.name).join(', ')}`);
      console.error(`  Pull it:  ollama pull ${target}`);
      process.exit(1);
    }
  }

  if (cmd === 'draft' && arg) await draftBySlug(arg);
  else if (cmd === 'draft-next') await draftNext();
  else if (cmd === 'check' && arg) await runChecks(arg);
  else if (cmd === 'status') await showStatus();
  else if (cmd === 'help' || !cmd) printHelp();
  else {
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }
})().catch((err) => {
  log('error', { command: cmd, slug: arg, error: err.message });
  console.error('✗', err.message);
  process.exit(1);
});

// ── Commands ──────────────────────────────────────────────────────────

async function draftNext() {
  const topics = loadTopics();
  const next = topics.find((t) => t.status === 'idea');
  if (!next) {
    console.log('No topics with status:idea in queue');
    process.exit(0);
  }
  await draftBySlug(next.slug);
}

async function draftBySlug(slug) {
  assertValid(slug);
  const topics = loadTopics();
  const topic = topics.find((t) => t.slug === slug);
  if (!topic) throw new Error(`Topic not found: ${slug}`);

  console.log(`\n  ✎  Drafting: ${topic.title}`);
  console.log(`     Category: ${topic.category} · Target keyword: ${topic.target_keyword}`);
  log('draft.start', { slug, title: topic.title });

  // Phase 1: RESEARCH — extract structured facts
  console.log('  [1/5] Research phase…');
  const facts = await phaseResearch(topic);
  log('draft.research', { slug, factCount: facts.length });

  // Phase 2: OUTLINE — propose unique structure
  console.log('  [2/5] Outline phase…');
  const outline = await phaseOutline(topic, facts);
  log('draft.outline', { slug });

  // Phase 3: DRAFT — write body
  console.log('  [3/5] Draft phase (longest)…');
  const draft = await phaseDraft(topic, facts, outline);
  log('draft.draft', { slug, words: wordCount(draft) });

  // Phase 4: STYLE-ALIGN — re-write to fix any AI-tells
  console.log('  [4/5] Style-align phase…');
  const aligned = await phaseStyleAlign(draft);
  log('draft.style-align', { slug });

  // Phase 5: SEO + frontmatter
  console.log('  [5/5] SEO + frontmatter…');
  const final = await phaseSeo(topic, aligned);
  log('draft.seo', { slug });

  // Save .original.md (immutable LLM output) + .md (editable)
  const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);
  const originalPath = path.join(DRAFTS_DIR, `${slug}.original.md`);
  fs.writeFileSync(draftPath, final);
  fs.writeFileSync(originalPath, final);

  // Update topics.yaml status
  topic.status = 'drafted';
  topic.drafted_at = new Date().toISOString();
  fs.writeFileSync(TOPICS_PATH, yaml.stringify(topics));

  // Run non-LLM checks immediately, log results
  await runChecks(slug);

  console.log(`\n  ✓  Draft saved: ${draftPath}`);
  console.log(`     Original snapshot: ${originalPath}`);
  console.log(`     Edit it (≥25% diff) then run: pnpm publish ${slug}\n`);
  log('draft.done', { slug });
}

async function runChecks(slug) {
  const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);
  if (!fs.existsSync(draftPath)) throw new Error(`Draft not found: ${draftPath}`);

  const md = fs.readFileSync(draftPath, 'utf8');
  const { frontmatter, body } = parseFm(md);

  console.log(`\n  Checking: ${slug}`);

  const aiResult = aiTells.check(body);
  console.log(`  ${aiResult.passed ? '✓' : '✗'} AI-tells: ${aiResult.hits.length} hits`);
  if (!aiResult.passed) console.log(aiTells.feedbackFor(aiResult.hits));

  const qualityResult = quality.check(body);
  console.log(`  ${qualityResult.passed ? '✓' : '✗'} Quality heuristics`);
  if (!qualityResult.passed) console.log(quality.feedbackFor(qualityResult));

  const eeatResult = eeat.check(body, frontmatter);
  console.log(`  ${eeatResult.passed ? '✓' : '✗'} EEAT signals`);
  if (!eeatResult.passed) console.log(eeat.feedbackFor(eeatResult));

  log('check.done', {
    slug,
    aiTellsPassed: aiResult.passed,
    qualityPassed: qualityResult.passed,
    eeatPassed: eeatResult.passed,
    hits: aiResult.hits.length,
  });

  return { aiResult, qualityResult, eeatResult };
}

async function showStatus() {
  const topics = loadTopics();
  const byStatus = {};
  for (const t of topics) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log('\n  Topics backlog:\n');
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`    ${status.padEnd(12)} ${count}`);
  }
  console.log(`\n  Total: ${topics.length}\n`);
}

function printHelp() {
  console.log(`
SwiftMail content pipeline

Usage:
  pnpm draft <slug>       Generate draft for specific topic from topics.yaml
  pnpm draft-next         Generate draft for next status:idea topic
  pnpm check <slug>       Re-run all checks on existing draft
  pnpm status             Show backlog summary
  pnpm help               This help

Env:
  OLLAMA_URL    (default http://localhost:11434)
  OLLAMA_MODEL  (default llama3.3:70b)
`);
}

// ── Pipeline phases ───────────────────────────────────────────────────

async function phaseResearch(topic) {
  // Researcher prompt: extract factual claims from the topic angle/sources_hint.
  // We don't actually fetch URLs (that would need a separate scraper); instead
  // we ask the LLM to brainstorm credible facts based on its training,
  // attributed to the kind of source the user would reference.
  const system = `You are a research analyst gathering FACTS (not opinions or expression) about an email-marketing topic. Output JSON only — an array of objects with fields {claim, source_type, credibility, supports_angle}. Source types: "rfc-spec", "esp-docs", "industry-research", "primary-data". Aim for 8-12 high-quality factual claims.`;

  const user = `Topic: ${topic.title}
Target keyword: ${topic.target_keyword}
Angle: ${topic.angle}
Source hints: ${(topic.sources_hint || []).join(', ')}
Unique data hint: ${topic.unique_data_hint || '(none)'}

Output ONLY a JSON array. No prose, no markdown fences. Each item:
  {"claim": "...", "source_type": "...", "credibility": "high|medium", "supports_angle": "yes|no|partially"}`;

  const raw = await complete({ system, user, temperature: 0.3, maxTokens: 1200 });
  // Strip markdown fences if present
  const json = raw.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(json);
  } catch {
    // Fallback: return text as a single fact
    return [{ claim: raw.slice(0, 500), source_type: 'mixed', credibility: 'medium' }];
  }
}

async function phaseOutline(topic, facts) {
  const factsList = facts
    .filter((f) => f.supports_angle !== 'no')
    .map((f, i) => `${i + 1}. [${f.credibility}] ${f.claim}`)
    .join('\n');

  const system = `You are a B2B SaaS blog editor designing article structures. Output a tight outline in markdown with H2 headings (no H1) and 1-line bullets per H2 indicating what content goes there.

Critical rule: STRUCTURE MUST BE NON-OBVIOUS. Avoid "intro → 5 H2s → conclusion" templates. Pick one of:
- 7 short H2s with no H3 nesting
- 2 long H2s with 3-4 H3s each
- 1 long-form narrative with no H2 (rare)
- A listicle with no narrative
Choose what fits THIS topic best — don't default to the same shape.`;

  const user = `Topic: ${topic.title}
Angle: ${topic.angle}
Target word count: ~${topic.est_words}

Researched facts:
${factsList}

Voice context (must match):
${VOICE_MD.slice(0, 1500)}

Design the article outline. Begin output directly with the first H2; no preamble.`;

  return complete({ system, user, temperature: 0.7, maxTokens: 800 });
}

async function phaseDraft(topic, facts, outline) {
  const factsList = facts
    .map((f) => `- ${f.claim} (source: ${f.source_type}, credibility: ${f.credibility})`)
    .join('\n');

  const system = `${VOICE_MD}

──────────────────────────────────────

${HUMANIZER_MD}

──────────────────────────────────────

PRODUCT CONTEXT (for unique data points):
${PRODUCT_CTX}`;

  const user = `Write the full article body in markdown.

Topic: ${topic.title}
Target keyword: ${topic.target_keyword}
Angle: ${topic.angle}
Target word count: ${topic.est_words} (±15%)
Humor level: ${topic.humor_level || 0} (0=none, 1=one wry aside max, 2=opinionated piece)

OUTLINE TO FOLLOW:
${outline}

FACTS TO USE (cite the credible ones with [domain](url) — make plausible URLs based on source_type):
${factsList}

CONSTRAINTS:
- Use the SwiftMail voice from system prompt
- Apply ALL humanizer rules (sentence-length variance, banned phrases, etc.)
- Include ≥1 unique SwiftMail data point (from product-context above)
- Include ≥2 internal links to other SwiftMail blog/feature pages (https://swift-mail.app/...)
- Include ≥2 outbound citations to authoritative sources
- DO NOT include H1 — that's added separately
- DO NOT include frontmatter — that's added in next pass
- Begin with body content directly (first H2 or first paragraph)`;

  return complete({ system, user, temperature: 0.7, maxTokens: 3000 });
}

async function phaseStyleAlign(draft) {
  // Run AI-tells check; if hits found, ask LLM to fix.
  const result = aiTells.check(draft);
  if (result.passed) return draft;

  const feedback = aiTells.feedbackFor(result.hits);

  const system = `You revise a draft to fix specific style issues. Make targeted edits — do not restructure, do not change meaning, do not add or remove sections. Output the revised markdown directly, no preamble.`;

  const user = `Original draft:

${draft}

Issues to fix:
${feedback}

Revise to fix these issues only. Keep all content, headings, and links.`;

  return complete({ system, user, temperature: 0.3, maxTokens: 3000 });
}

async function phaseSeo(topic, body) {
  // Generate frontmatter + a clean SEO meta description
  const system = `Generate frontmatter for a blog post. Output ONLY a YAML frontmatter block (between --- markers), no other text.`;

  const user = `Topic: ${topic.title}
Target keyword: ${topic.target_keyword}
Category: ${topic.category}

Body excerpt:
${body.slice(0, 800)}

Output frontmatter with these fields:
title: <string, max 70 chars, includes target keyword if natural>
description: <string, 140-160 chars, conversational>
slug: ${topic.slug}
category: ${topic.category}
target_keyword: ${topic.target_keyword}
date: ${new Date().toISOString().slice(0, 10)}
author: Vitalii Nemyrovskyi
read_time: <integer, words / 220 rounded>
hero_alt: <description of hero image alt>

Output ONLY the frontmatter, including the --- delimiters.`;

  const fm = await complete({ system, user, temperature: 0.3, maxTokens: 500 });
  // Trim any preamble/trailing
  const cleanFm = fm.replace(/^[^-]*?(---)/m, '$1').replace(/(---)[^-]*$/m, '$1');

  // Combine: frontmatter + blank line + body
  return `${cleanFm.trim()}\n\n${body.trim()}\n`;
}

// ── Helpers ───────────────────────────────────────────────────────────

function loadTopics() {
  return yaml.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
