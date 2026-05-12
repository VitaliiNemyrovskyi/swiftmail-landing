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
import { complete, ping, pingAll, listModels } from './lib/ollama-client.mjs';
import { slugify, assertValid } from './lib/slug.mjs';
import { serialize as serializeFm, parse as parseFm, assertFields } from './lib/frontmatter.mjs';
import { log } from './lib/log.mjs';
import { fetchOne as fetchImage, buildQuery as buildImageQuery } from './lib/images.mjs';
import * as aiTells from './checks/ai-tells.mjs';
import * as quality from './checks/quality-heuristics.mjs';
import * as eeat from './checks/eeat.mjs';
import * as factGrounding from './checks/fact-grounding.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// voice.md / humanizer.md are the full references (~14K chars combined).
// The *-compact.md siblings are runtime-trimmed (~3K chars total) used
// in LLM prompts. Reasons:
//   1. llama-3.3-70b's effective attention degrades after ~3-4K tokens
//      of system prompt — over-stuffing dilutes the actual writing task.
//   2. Local Ollama defaults to 4096-token context (legacy back-end).
//   3. Voice + humanizer combined was ~5000 tokens before this trim;
//      moved to ~1300 tokens (combined) on 2026-05-08 as part of the
//      drafting-quality push (PR #4). See AUDIT in /docs if extant.
const VOICE_COMPACT = fs.readFileSync(path.join(ROOT, 'voice-compact.md'), 'utf8');
const HUMANIZER_COMPACT = fs.readFileSync(path.join(ROOT, 'humanizer-compact.md'), 'utf8');
// product-context.md condensed: keep only the metrics + features section
// for runtime use. Falls back to full file if not present.
const PRODUCT_CTX_COMPACT = compactProductContext(
  fs.readFileSync(path.join(ROOT, 'product-context.md'), 'utf8')
);

function compactProductContext(full) {
  // Keep only "Real metrics" + "Core feature surface" + brand voice anchors
  // — sections most useful for grounding article facts.
  const sections = full.split(/^## /m);
  const wanted = ['Real metrics', 'Core feature surface', 'Founder voice anchors', 'Stage'];
  const keep = sections.filter((s) => wanted.some((w) => s.startsWith(w)));
  return keep.length > 0
    ? '## ' + keep.join('\n## ').slice(0, 1500)
    : full.slice(0, 1500);
}

const TOPICS_PATH = path.join(ROOT, 'topics.yaml');
const DRAFTS_DIR = path.join(ROOT, 'drafts');

if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

// ── Top-level commands ────────────────────────────────────────────────

const cmd = process.argv[2];
const arg = process.argv[3];

const CMDS_NEEDING_OLLAMA = new Set(['draft', 'draft-next']);

(async () => {
  // Provider chain pre-flight check. If LLM_PROVIDER_CHAIN is set we
  // ping every provider in the chain; succeed if AT LEAST ONE is up.
  // Single-provider mode (legacy) keeps the old strict check.
  if (cmd && CMDS_NEEDING_OLLAMA.has(cmd)) {
    const chainEnv = process.env.LLM_PROVIDER_CHAIN;
    if (chainEnv) {
      const status = await pingAll();
      const upCount = Object.values(status).filter(Boolean).length;
      const summary = Object.entries(status)
        .map(([p, ok]) => `${p}=${ok ? 'up' : 'DOWN'}`)
        .join(', ');
      console.log(`  Provider chain: ${summary}`);
      if (upCount === 0) {
        console.error('✗ All providers in chain are down. Check API keys + network.');
        process.exit(1);
      }
      if (upCount < Object.keys(status).length) {
        console.log(`  ⚠ ${Object.keys(status).length - upCount}/${Object.keys(status).length} providers down — continuing with available fallbacks.`);
      }
    } else {
      // Legacy single-provider mode.
      const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
      const alive = await ping();
      if (!alive) {
        if (provider === 'groq') {
          console.error('✗ Groq not reachable — check GROQ_API_KEY validity at https://console.groq.com');
        } else if (provider === 'glm') {
          console.error('✗ GLM not reachable — check GLM_API_KEY validity at https://docs.z.ai');
        } else if (provider === 'gemini') {
          console.error('✗ Gemini not reachable — check GEMINI_API_KEY validity at https://aistudio.google.com/apikey');
        } else {
          console.error(`✗ Ollama not reachable at ${process.env.OLLAMA_URL || 'http://localhost:11434'}`);
          console.error('  Set OLLAMA_URL env var, or run: ollama serve');
        }
        process.exit(1);
      }
      // Ollama-only: also verify the requested model is loaded.
      if (provider === 'ollama') {
        const models = await listModels();
        const target = process.env.OLLAMA_MODEL || 'llama3.3:70b';
        if (!models.find((m) => m.name === target)) {
          console.error(`✗ Model "${target}" not loaded. Available: ${models.map((m) => m.name).join(', ')}`);
          console.error(`  Pull it:  ollama pull ${target}`);
          process.exit(1);
        }
      }
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

  // Phase 3: DRAFT — single call with provider-chain auto-fallback.
  //
  // Was best-of-3 across 3 paralleль calls to the same provider. That
  // burst pattern triggered free-tier rate limits (Groq 429 TPD,
  // GLM 1302 RPM). The fallback chain inside complete() now does the
  // resilience job — if Groq returns 429, try GLM; if GLM 1302, try
  // Gemini. Single call = no burst = stable. We trade "best-of-N
  // diversity" for "actually-publishes-an-article" reliability —
  // the audit's #1 stability win was supposed to be best-of-3, but
  // in practice it was the #1 cause of run failures. Revision loop
  // (downstream) catches quality issues per-pass.
  console.log('  [3/5] Draft phase…');
  const draft = await phaseDraft(topic, facts, outline, { temperature: 0.85 });
  const score = scoreDraft(draft, topic);
  log('draft.draft', { slug, words: score.words, score: score.score });
  console.log(`      drafted: ${score.words} words, score ${score.score.toFixed(1)}, ${score.aiTellHits} AI-tell hits`);

  // Phase 4: STYLE-ALIGN — re-write to fix any AI-tells.
  // Note: still gated on aiTells.check() — if no banned phrases, we skip.
  // The deeper voice-injection rules (humanizer-compact) should already
  // be applied by the draft's system prompt; style-align is the cleanup
  // pass for the leftover regex hits.
  console.log('  [4/5] Style-align phase…');
  const aligned = await phaseStyleAlign(draft);
  log('draft.style-align', { slug });

  // Phase 5: SEO + frontmatter
  console.log('  [5/5] SEO + frontmatter…');
  const final = await phaseSeo(topic, aligned);
  log('draft.seo', { slug });

  // Phase 6 (silent): fetch a relevant Pexels image for the article.
  // Skipped if PEXELS_API_KEY missing or fetch fails — pipeline continues.
  if (process.env.PEXELS_API_KEY) {
    console.log('  [+] Fetching relevant image via Pexels…');
    try {
      const query = buildImageQuery(topic);
      const result = await fetchImage({ slug, query });
      if (result) {
        log('draft.image', { slug, query, photographer: result.photographer, bytes: result.bytes });
        console.log(`      ✓ ${result.bytes / 1024 | 0}KB · ${result.photographer}`);
      } else {
        console.log(`      · no Pexels result for "${query}"`);
      }
    } catch (err) {
      console.log(`      · image fetch skipped: ${err.message}`);
      log('draft.image-failed', { slug, error: err.message });
    }
  } else {
    console.log('  [+] Skipping image fetch (PEXELS_API_KEY not set)');
  }

  // ── Revision loop ────────────────────────────────────────────
  //
  // Gates flag specific issues (banned phrases, low sentence variance,
  // missing first-person, vague language). Pre-2026-05-08 the pipeline
  // just logged + published. Now: up to 2 revision passes per draft.
  // Each pass passes the SPECIFIC fail messages back to the model so
  // it knows what to fix. Stops as soon as all gates pass.
  //
  // Cost: 0–2 extra LLM calls. ~6s each on Groq. Worth it — eliminates
  // the "publish anyway with warnings" pattern that was diluting blog quality.
  let revised = final;
  for (let pass = 1; pass <= 2; pass += 1) {
    const issues = collectGateFeedback(revised, topic);
    if (issues.length === 0) {
      log('draft.revision-loop', { slug, passes: pass - 1, status: 'all-passed' });
      break;
    }
    console.log(
      `  [revision ${pass}/2] gates flagged ${issues.length} issue(s) (${issues.map((i) => i.gate).join(', ')}) — asking LLM to fix…`,
    );
    log('draft.revision-loop', { slug, pass, issueCount: issues.length, gates: issues.map((i) => i.gate) });
    revised = await phaseRevise(revised, issues);
  }
  const polished = revised;

  // Save .original.md (immutable LLM output before revision) + .md (final).
  const draftPath = path.join(DRAFTS_DIR, `${slug}.md`);
  const originalPath = path.join(DRAFTS_DIR, `${slug}.original.md`);
  fs.writeFileSync(draftPath, polished);
  fs.writeFileSync(originalPath, final); // pre-revision snapshot for diff

  // Update topics.yaml status
  topic.status = 'drafted';
  topic.drafted_at = new Date().toISOString();
  fs.writeFileSync(TOPICS_PATH, yaml.stringify(topics));

  // Final checks pass — at this point gates either ALL pass or remaining
  // ones survived 2 revision attempts (e.g. eeat outbound-citations
  // requires LLM hallucinating real URLs, which we accept as a noted
  // warning rather than blocking publish).
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

  // Look up the topic so fact-grounding can read its sources_hint /
  // unique_data_hint. If the slug isn't in topics.yaml (e.g. a manual
  // draft), fall back to an empty topic — fact-grounding will only
  // accept numbers verifiable from product-context.md.
  const topics = loadTopics();
  const topic = topics.find((t) => t.slug === slug) || {};
  const factResult = factGrounding.check(body, {
    topic,
    productContext: PRODUCT_CTX_COMPACT,
  });
  console.log(`  ${factResult.passed ? '✓' : '✗'} Fact-grounding${factResult.passed ? '' : ` (${factResult.fails.length} unverified specifics)`}`);
  if (!factResult.passed) console.log(factGrounding.feedbackFor(factResult));

  log('check.done', {
    slug,
    aiTellsPassed: aiResult.passed,
    qualityPassed: qualityResult.passed,
    eeatPassed: eeatResult.passed,
    factGroundingPassed: factResult.passed,
    hits: aiResult.hits.length,
    factFails: factResult.fails.length,
  });

  return { aiResult, qualityResult, eeatResult, factResult };
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
  // For news topics, we explicitly cite the source URL as the primary fact source.
  const isNews = topic.source_type === 'news';

  const system = isNews
    ? `You are a research analyst commenting on a news item from the email-marketing industry. The source URL is the primary fact source — extract the news, then propose 6-10 secondary facts and SwiftMail-specific angles that frame our take. Output JSON only — array of {claim, source_type, credibility, supports_angle}. Source types: "primary-news" (from the cited URL), "industry-context", "swiftmail-pov", "esp-docs".`
    : `You are a research analyst gathering FACTS (not opinions or expression) about an email-marketing topic. Output JSON only — an array of objects with fields {claim, source_type, credibility, supports_angle}. Source types: "rfc-spec", "esp-docs", "industry-research", "primary-data". Aim for 8-12 high-quality factual claims.`;

  const user = isNews
    ? `News topic: ${topic.title}
Target keyword: ${topic.target_keyword}
Angle: ${topic.angle}
Source URL (primary): ${topic.source_url}
Source feed: ${topic.source_feed}
Source publication date: ${topic.source_pubdate}
Unique data hint: ${topic.unique_data_hint || '(none)'}

Output ONLY a JSON array. Each item:
  {"claim": "...", "source_type": "primary-news|industry-context|swiftmail-pov|esp-docs", "credibility": "high|medium", "supports_angle": "yes|no|partially"}

The first 3-4 claims should restate the news facts (from the source URL).
The remaining 4-6 should be SwiftMail's framing — what this means for SMB email senders, our beta-tester data if applicable, and the action item for readers.`
    : `Topic: ${topic.title}
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

Design the article outline. Begin output directly with the first H2; no preamble.`;

  return complete({ system, user, temperature: 0.7, maxTokens: 800 });
}

/**
 * Generate one full article body. Called 3× in best-of-3 mode; the
 * caller varies `temperature` per attempt to broaden the candidate
 * space.
 *
 * Note `est_words ± 15%` is now an enforced floor — old prompts treated
 * it as soft target and the model often stopped at half. Hard "MUST be
 * ≥1300 words" plus per-section length hints fix the early-finish bug.
 */
async function phaseDraft(topic, facts, outline, opts = {}) {
  const factsList = facts
    .map((f) => `- ${f.claim} (source: ${f.source_type}, credibility: ${f.credibility})`)
    .join('\n');

  const isNews = topic.source_type === 'news';
  const newsContext = isNews
    ? `\n\nNEWS CONTEXT: This article responds to a news item.
- Primary source URL (cite explicitly with [text](url) in body): ${topic.source_url}
- Original feed: ${topic.source_feed}
- Source pub-date: ${topic.source_pubdate}
- The first paragraph MUST cite the source URL and quote/paraphrase 1-2 lines.
- The middle MUST contain SwiftMail's POV — what it means for our SMB / Shopify ICP, with our internal data if applicable.
- The closing MUST give the reader a concrete action: what to check / change / monitor as a result.\n`
    : '';

  const targetWords = topic.est_words || 1500;
  const minWords = Math.round(targetWords * 0.85);
  const maxWords = Math.round(targetWords * 1.15);

  // System prompt = voice + humanizer + product context. Combined budget
  // ~1500 tokens after the 2026-05-08 distillation.
  const system = `${VOICE_COMPACT}

──────────────────────────────────────

${HUMANIZER_COMPACT}

──────────────────────────────────────

PRODUCT CONTEXT (for unique data points):
${PRODUCT_CTX_COMPACT}`;

  const user = `Write the full article body in markdown.

Topic: ${topic.title}
Target keyword: ${topic.target_keyword}
Angle: ${topic.angle}
**Word count requirement: ${minWords}–${maxWords} words.** This is a HARD floor —
articles shorter than ${minWords} words will be rejected. Treat it as a writing
brief, not a soft target. Most H2 sections should be 200–350 words; an article
with 5 H2s should land near ${targetWords} words.
Humor level: ${topic.humor_level || 0} (0=none, 1=one wry aside max, 2=opinionated piece)
${newsContext}
OUTLINE TO FOLLOW:
${outline}

FACTS TO USE (cite the credible ones with [domain](url) — make plausible URLs based on source_type):
${factsList}

CONSTRAINTS:
- Use the SwiftMail voice from system prompt
- Apply ALL humanizer rules — particularly sentence-length variance (≥1 in 5
  sentences under 8 words), 1–2 fragments, and ≥1 first-person experience marker
- Include ≥1 unique SwiftMail data point (use the metrics in product context:
  34% price hesitation, 22% form friction, 47% multi-session journeys, etc.)
- Include ≥2 internal links to other SwiftMail blog/feature pages (https://swift-mail.app/...)
- Include ≥2 outbound citations to authoritative sources [domain](url)
- DO NOT include H1 — that's added separately
- DO NOT include frontmatter — that's added in next pass
- Begin with body content directly (first H2 or first paragraph)`;

  // maxTokens 4000 (was 3000) — gives headroom for 1700-word articles
  // when the model uses verbose phrasing. Empirically ~600 tokens of slack.
  return complete({
    system,
    user,
    temperature: opts.temperature ?? 0.7,
    maxTokens: 4000,
  });
}

/**
 * Score a candidate draft for best-of-N selection. Higher is better.
 *
 * Combines:
 *   - Word count match to target (closer = better)
 *   - AI-tells hits (fewer = better)
 *   - Quality-heuristic fails (fewer = better)
 *   - First-person markers (presence required by voice)
 *
 * No LLM call — purely structural metrics. Sub-millisecond per draft.
 */
function scoreDraft(body, topic) {
  const words = wordCount(body);
  const targetWords = topic.est_words || 1500;

  const aiResult = aiTells.check(body);
  const aiTellHits = aiResult.hits.length;

  const qResult = quality.check(body);
  const qualityFails = qResult.passed ? 0 : (qResult.fails || []).length;

  // Word-count distance: 0 at target, 1 at 50% off, capped at 1.
  const wcDistance = Math.min(1, Math.abs(words - targetWords) / targetWords);
  const wcScore = (1 - wcDistance) * 30; // 0–30 points

  // Penalties — each ai-tell costs 5, each quality fail costs 8.
  const aiPenalty = aiTellHits * 5;
  const qPenalty = qualityFails * 8;

  // Hard floor: drafts under 800 words score abysmally regardless of
  // other metrics — they're just too short to be useful.
  const lengthFloor = words < 800 ? -50 : 0;

  return {
    score: wcScore - aiPenalty - qPenalty + lengthFloor,
    words,
    aiTellHits,
    qualityFails,
  };
}

/**
 * Concrete URL suggestions per topic category. The LLM needs explicit
 * "use one of these real URLs" hints — without them it either skips
 * citations entirely (today's fail mode) or invents URLs that aren't
 * on the EEAT whitelist. Curated 2026-05-08 from the AUTHORITATIVE_DOMAINS
 * list in checks/eeat.mjs; URLs verified to exist on real domains
 * (no spot-check that they 200 — that's a P1 follow-up).
 */
/**
 * Curated 2026-05-08 from the AUTHORITATIVE_DOMAINS list in checks/eeat.mjs.
 * URLs were spot-checked for HTTP 200 at curation time; lib/markdown-render
 * also strips any non-whitelist link from the rendered HTML as a second
 * defence layer (the model still occasionally invents URLs not on this
 * list — they get downgraded to plain text so the article doesn't ship
 * dead links).
 *
 * Followup (P1): periodic CI check that re-curls every URL here and fails
 * the build if any 404. For now operator updates manually.
 */
/**
 * Curated 2026-05-12 after a sweep that removed all email-space
 * vendor URLs (Postmark, Mailgun, SendGrid) — including transactional
 * ESPs whose blog posts the LLM was happily citing because they
 * formally weren't on the "marketing-automation" competitor list.
 * From SwiftMail's GTM angle they ARE competitors (same readers, same
 * trade press, same search intent), so we stop sending readers there.
 *
 * What's left: standards bodies (RFC), platform docs (Microsoft,
 * Google support), research (Baymard, Litmus, Statista). All
 * neutral, none compete for SwiftMail's user.
 *
 * `comparison` is the one category where citing competitors is the
 * whole point — those URLs stay, but the renderer slaps `rel="nofollow
 * noopener"` on them automatically (lib/markdown-render.mjs).
 */
const SUGGESTED_URLS_BY_CATEGORY = {
  deliverability: [
    'https://datatracker.ietf.org/doc/html/rfc7489 (DMARC RFC 7489)',
    'https://datatracker.ietf.org/doc/html/rfc6376 (DKIM RFC 6376)',
    'https://datatracker.ietf.org/doc/html/rfc7208 (SPF RFC 7208)',
    'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-about (MS docs)',
    'https://support.google.com/a/answer/2466580 (Google Workspace authentication)',
    'https://www.litmus.com/blog (email-deliverability research)',
  ],
  warmup: [
    'https://datatracker.ietf.org/doc/html/rfc7489',
    'https://datatracker.ietf.org/doc/html/rfc6376',
    'https://datatracker.ietf.org/doc/html/rfc7208',
    'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-about',
    'https://www.litmus.com/blog',
  ],
  ecommerce: [
    'https://baymard.com/lists/cart-abandonment-rate (cart-abandonment research)',
    'https://www.litmus.com/blog (email research)',
    'https://datatracker.ietf.org/doc/html/rfc7489 (DMARC RFC)',
    'https://www.statista.com/topics/871/online-shopping/ (e-commerce stats)',
  ],
  automation: [
    'https://www.litmus.com/blog',
    'https://baymard.com/research',
    'https://datatracker.ietf.org/doc/html/rfc7208',
    'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-about',
  ],
  // Comparison articles are the ONLY place where direct competitor
  // links are appropriate (reader explicitly wants to compare). The
  // renderer auto-adds rel="nofollow noopener" to anything in
  // COMPETITOR_DOMAINS so we still don't pass SEO juice.
  comparison: [
    'https://www.klaviyo.com/pricing',
    'https://mailchimp.com/pricing/',
    'https://www.activecampaign.com/pricing',
  ],
  // Generic fallback for topics that don't match the above
  default: [
    'https://datatracker.ietf.org/doc/html/rfc7489 (DMARC RFC)',
    'https://www.litmus.com/blog',
    'https://baymard.com/research',
    'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-about',
  ],
};

function suggestedUrlsForTopic(topic) {
  const cat = (topic.category || '').toLowerCase();
  // Try exact category match, then keyword-in-slug, then default.
  if (SUGGESTED_URLS_BY_CATEGORY[cat]) return SUGGESTED_URLS_BY_CATEGORY[cat];
  const slug = (topic.slug || '').toLowerCase();
  if (/warm[- ]?up/.test(slug)) return SUGGESTED_URLS_BY_CATEGORY.warmup;
  if (/cart|checkout|shopify|ecom/.test(slug)) return SUGGESTED_URLS_BY_CATEGORY.ecommerce;
  if (/automation|sequence|flow/.test(slug)) return SUGGESTED_URLS_BY_CATEGORY.automation;
  if (/vs|alternatives|comparison/.test(slug)) return SUGGESTED_URLS_BY_CATEGORY.comparison;
  return SUGGESTED_URLS_BY_CATEGORY.default;
}

/**
 * Collect specific, actionable feedback from all gates. Used by the
 * revision loop — we don't just say "fix it", we say "fix THIS specific
 * sentence on line 47 because it uses 'delve'".
 *
 * @param {string} body markdown body
 * @param {object} topic topic from topics.yaml (used for URL suggestions)
 */
function collectGateFeedback(body, topic = {}) {
  const issues = [];

  const ai = aiTells.check(body);
  if (!ai.passed) {
    issues.push({
      gate: 'ai-tells',
      detail: aiTells.feedbackFor(ai.hits),
    });
  }

  const q = quality.check(body);
  if (!q.passed) {
    issues.push({
      gate: 'quality-heuristics',
      detail: quality.feedbackFor(q),
    });
  }

  // EEAT body-only checks (outbound citations, internal links, unique
  // data point). The author-byline check needs frontmatter, which is
  // added in phaseSeo AFTER revision — so we filter it out here. The
  // other 3 EEAT checks operate on the body alone and are exactly what
  // a revision pass can fix.
  const e = eeat.check(body, {});
  if (!e.passed) {
    const bodyFails = (e.fails || []).filter((f) => f.check !== 'author-byline');
    if (bodyFails.length > 0) {
      const detailLines = bodyFails.map((f) => `[${f.check}] ${f.detail}`);
      // Append concrete URL suggestions when outbound-citations fails —
      // without these, the LLM either skips citations or invents domains
      // not on the EEAT authoritative list.
      if (bodyFails.some((f) => f.check === 'outbound-citations')) {
        const urls = suggestedUrlsForTopic(topic);
        detailLines.push(
          'CONCRETE URL SUGGESTIONS — use 2 or more of these as outbound citations. ' +
            'Format: [text](url). Pick those most relevant to the article topic:',
          ...urls.map((u) => `  - ${u}`),
        );
      }
      issues.push({
        gate: 'eeat',
        detail: detailLines.join('\n'),
      });
    }
  }

  // Fact-grounding: catch invented numbers (prices, percentages, dates)
  // that appear near competitor names but aren't in any provided source.
  // The LLM regularly fabricates Klaviyo / DigiCert / Bloomreach prices
  // ("$1500/yr for VMC" when DigiCert is actually $400) — that's an
  // E-E-A-T penalty AND brand-credibility hit. Revision loop catches it
  // and asks LLM to either cite the source or qualitatively rewrite.
  const fg = factGrounding.check(body, {
    topic,
    productContext: PRODUCT_CTX_COMPACT,
  });
  if (!fg.passed) {
    issues.push({
      gate: 'fact-grounding',
      detail: factGrounding.feedbackFor(fg),
    });
  }

  return issues;
}

/**
 * One revision pass. Given a draft and the list of gate-flagged issues,
 * ask the LLM to fix them in place — no restructuring, no length change,
 * just targeted edits. Temperature low (0.3) since this is editing,
 * not generation.
 */
async function phaseRevise(draft, issues) {
  const issueText = issues
    .map((i, n) => `${n + 1}. ${i.gate}:\n${i.detail}`)
    .join('\n\n');

  const system = `You are revising a B2B blog draft to fix specific style issues flagged by automated gates. Make TARGETED edits only. Do not restructure sections. Do not change article length. Do not change meaning. Output the revised markdown directly — no preamble, no commentary.`;

  const user = `Original draft:

${draft}

Issues to fix (each lists a specific gate failure with concrete sentences):

${issueText}

Rewrite the draft with these issues fixed. Keep ALL headings, links, sections, and overall length. Output only the revised markdown.`;

  return complete({ system, user, temperature: 0.3, maxTokens: 4000 });
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

  // Validate / repair the frontmatter. The LLM occasionally drops the
  // `title:` line entirely (or echoes the placeholder `<string, max 70
  // chars>` literal back), which then renders as the literal word
  // "undefined" in the published HTML title tag (observed 2026-05-08
  // first real article). Fall back to topic data for any missing field
  // so we never ship a draft with undefined fields.
  const repaired = ensureRequiredFrontmatter(cleanFm.trim(), topic, body);

  // Combine: frontmatter + blank line + body
  return `${repaired}\n\n${body.trim()}\n`;
}

/**
 * Make sure the frontmatter block has every required field. Missing
 * fields are filled from `topic` (the topics.yaml entry) or computed
 * from the body. Returns a cleaned frontmatter string with `---`
 * delimiters intact.
 */
function ensureRequiredFrontmatter(fmRaw, topic, body) {
  // Parse rough YAML — we just need key:value pairs.
  const lines = fmRaw.split('\n');
  const fields = {};
  let inFm = false;
  for (const line of lines) {
    if (line.trim() === '---') {
      inFm = !inFm;
      continue;
    }
    if (!inFm) continue;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    // Strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // If LLM left placeholder like <string, max 70 chars> verbatim,
    // treat as missing.
    if (/^<.*>$/.test(v) || v === 'undefined' || v === '') v = '';
    fields[m[1]] = v;
  }

  // Fill defaults for missing fields.
  const today = new Date().toISOString().slice(0, 10);
  const wordsPerMin = 220;
  const readTime = Math.max(1, Math.round(wordCount(body) / wordsPerMin));

  if (!fields.title) fields.title = topic.title;
  if (!fields.description) {
    fields.description = (topic.angle || `${topic.title} — for SwiftMail customers.`)
      .slice(0, 160);
  }
  if (!fields.slug) fields.slug = topic.slug;
  if (!fields.category) fields.category = topic.category || 'general';
  if (!fields.target_keyword) fields.target_keyword = topic.target_keyword || '';
  if (!fields.date) fields.date = today;
  if (!fields.author) fields.author = 'Vitalii Nemyrovskyi';
  if (!fields.read_time) fields.read_time = String(readTime);
  if (!fields.hero_alt) fields.hero_alt = topic.title;

  // Quote values that contain colons or other YAML metacharacters.
  const yaml = Object.entries(fields)
    .map(([k, v]) => {
      const needsQuote = /[:#\n"]/.test(v) || v.startsWith('-');
      const safe = needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v;
      return `${k}: ${safe}`;
    })
    .join('\n');

  return `---\n${yaml}\n---`;
}

// ── Helpers ───────────────────────────────────────────────────────────

function loadTopics() {
  return yaml.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
