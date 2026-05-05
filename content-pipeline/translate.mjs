#!/usr/bin/env node
// translate.mjs — translate published English markdown to es/fr/de/pt
//
// Usage:
//   node translate.mjs <slug>             # translates to all 4 langs
//   node translate.mjs <slug> es,fr       # only specified langs
//
// Reads:  drafts/<slug>.md (must have been published or at least have frontmatter)
// Writes: drafts/<slug>.<lang>.md (per-language drafts)
//
// Each translation is checked against the source for:
//   - brand-name preservation
//   - acronym preservation
//   - URL preservation
//   - heading parity
//   - length deviation
//
// Failures auto-trigger a re-translate with feedback.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete, ping } from './lib/ollama-client.mjs';
import { parse as parseFm, serialize as serializeFm } from './lib/frontmatter.mjs';
import { log } from './lib/log.mjs';
import * as transQuality from './checks/translation-quality.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DRAFTS_DIR = path.join(ROOT, 'drafts');
const ALL_LANGS = ['es', 'fr', 'de', 'pt', 'uk'];

const TRANSLATION_RULES = fs.readFileSync(path.join(ROOT, 'translation-rules.md'), 'utf8');
const VOICE = {
  es: fs.readFileSync(path.join(ROOT, 'voice-es.md'), 'utf8'),
  fr: fs.readFileSync(path.join(ROOT, 'voice-fr.md'), 'utf8'),
  de: fs.readFileSync(path.join(ROOT, 'voice-de.md'), 'utf8'),
  pt: fs.readFileSync(path.join(ROOT, 'voice-pt.md'), 'utf8'),
  uk: fs.readFileSync(path.join(ROOT, 'voice-uk.md'), 'utf8'),
};

// ── Entrypoint ────────────────────────────────────────────────────────

const slug = process.argv[2];
const langArg = process.argv[3];

if (!slug) {
  console.error('Usage: node translate.mjs <slug> [lang1,lang2,...]');
  process.exit(1);
}

const targets = langArg ? langArg.split(',') : ALL_LANGS;
for (const l of targets) {
  if (!ALL_LANGS.includes(l)) {
    console.error(`Unknown language: ${l}. Allowed: ${ALL_LANGS.join(', ')}`);
    process.exit(1);
  }
}

(async () => {
  const alive = await ping();
  if (!alive) {
    console.error(`✗ Ollama not reachable at ${process.env.OLLAMA_URL || 'http://localhost:11434'}`);
    process.exit(1);
  }

  const sourcePath = path.join(DRAFTS_DIR, `${slug}.md`);
  if (!fs.existsSync(sourcePath)) {
    console.error(`✗ Source draft not found: ${sourcePath}`);
    process.exit(1);
  }

  const sourceMd = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter: srcFm, body: srcBody } = parseFm(sourceMd);

  console.log(`\n  ⌘  Translating: ${srcFm.title}`);
  console.log(`     Languages: ${targets.join(', ')}\n`);

  for (const lang of targets) {
    console.log(`  → ${lang}`);
    log('translate.start', { slug, lang });
    try {
      await translateOne(slug, srcFm, srcBody, lang);
      log('translate.done', { slug, lang });
    } catch (err) {
      log('translate.error', { slug, lang, error: err.message });
      console.error(`    ✗ ${lang} failed: ${err.message}`);
    }
  }

  console.log(`\n  ✓  All translations saved to drafts/${slug}.<lang>.md`);
  console.log(`     Review them, then run: pnpm publish ${slug} --langs=all\n`);
})().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});

// ── Translate one language ────────────────────────────────────────────

async function translateOne(slug, srcFm, srcBody, lang, retryWithFeedback = '') {
  // Translate body
  const translatedBody = await translateBody(srcBody, lang, retryWithFeedback);

  // Translate frontmatter (title, description, hero_alt)
  const translatedFm = await translateFrontmatter(srcFm, lang);

  // Merge: translated frontmatter + translated body
  const finalMd = serializeFm({
    frontmatter: { ...translatedFm, slug, date: srcFm.date, author: srcFm.author, read_time: srcFm.read_time, lang, source_lang: 'en', source_slug: slug },
    body: translatedBody,
  });

  // Quality check
  const qResult = transQuality.check(srcBody, translatedBody, lang);

  if (!qResult.passed && !retryWithFeedback) {
    console.log(`    ⚠  Translation issues (${qResult.fails.length}):`);
    console.log('       ' + transQuality.feedbackFor(qResult).split('\n').join('\n       '));
    console.log(`    ↻  Re-translating with feedback…`);
    log('translate.retry', { slug, lang, issues: qResult.fails.length });
    return translateOne(slug, srcFm, srcBody, lang, transQuality.feedbackFor(qResult));
  }

  if (!qResult.passed) {
    console.log(`    ⚠  Still failing after retry. Saving anyway with translation_status: needs_review.`);
    translatedFm.translation_status = 'needs_review';
  }

  const outputPath = path.join(DRAFTS_DIR, `${slug}.${lang}.md`);
  fs.writeFileSync(outputPath, finalMd);
  console.log(`    ✓ ${outputPath} (${qResult.stats.translationWords}w, ratio ${qResult.stats.lengthRatio})`);
}

async function translateBody(srcBody, lang, retryFeedback = '') {
  const langName = { es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese (pt-BR)', uk: 'Ukrainian' }[lang];

  const system = `${TRANSLATION_RULES}

──────────────────────────────────────

TARGET LANGUAGE VOICE:
${VOICE[lang]}`;

  let user = `Translate this article from English to ${langName}.

Output ONLY the translated markdown body. No preamble, no frontmatter, no commentary.

Source:

${srcBody}`;

  if (retryFeedback) {
    user += `\n\nPREVIOUS ATTEMPT HAD ISSUES:\n${retryFeedback}\n\nFix these issues. Output corrected translation.`;
  }

  return complete({ system, user, temperature: 0.4, maxTokens: 8000 });
}

async function translateFrontmatter(srcFm, lang) {
  const langName = { es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese (pt-BR)', uk: 'Ukrainian' }[lang];

  const system = `Translate the title, description, and hero_alt fields of a blog post frontmatter. Preserve brand names (SwiftMail, Klaviyo, etc.) and technical acronyms (DKIM, SPF, etc.) exactly. Output ONLY a JSON object with the translated fields, no other text.`;

  const user = `Source language: English
Target language: ${langName}

Source:
{
  "title": ${JSON.stringify(srcFm.title || '')},
  "description": ${JSON.stringify(srcFm.description || '')},
  "hero_alt": ${JSON.stringify(srcFm.hero_alt || '')}
}

Output:
{"title": "...", "description": "...", "hero_alt": "..."}

Constraints:
- title: max 70 chars
- description: 140-160 chars
- hero_alt: keep concise, descriptive
- Preserve "SwiftMail", "Klaviyo", etc. exactly`;

  const raw = await complete({ system, user, temperature: 0.3, maxTokens: 800 });
  const json = raw.replace(/```json\n?|\n?```/g, '').trim();
  try {
    const parsed = JSON.parse(json);
    return {
      title: parsed.title || srcFm.title,
      description: parsed.description || srcFm.description,
      hero_alt: parsed.hero_alt || srcFm.hero_alt,
      category: srcFm.category,
      target_keyword: srcFm.target_keyword,
    };
  } catch {
    // Fallback: keep English (better than corrupted)
    return {
      title: srcFm.title,
      description: srcFm.description,
      hero_alt: srcFm.hero_alt,
      category: srcFm.category,
      target_keyword: srcFm.target_keyword,
      translation_status: 'frontmatter_failed',
    };
  }
}
