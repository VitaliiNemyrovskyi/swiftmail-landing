# SwiftMail Content Pipeline

LLM-assisted blog publishing pipeline. Generates drafts via Ollama, runs
quality gates, translates to 4 languages, publishes to git → Cloudflare Pages.

## Architecture

```
┌─────────────────┐
│   topics.yaml   │  ← 50+ queued topics with metadata
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  pipeline.mjs (Ollama)                  │
│  ┌────────┐ ┌────────┐ ┌────────┐       │
│  │Research│→│Outline │→│ Draft  │       │
│  └────────┘ └────────┘ └────────┘       │
│      ↓                       ↓          │
│  ┌──────────────┐ ┌─────────────┐       │
│  │ Style-align  │→│ SEO + FM    │       │
│  └──────────────┘ └─────────────┘       │
└────────┬────────────────────────────────┘
         │
         ▼
   drafts/<slug>.md  ← human edits ≥25%
         │
         ▼
┌─────────────────────────────────────────┐
│  publish.mjs                            │
│   pre-publish gate (HARD):              │
│   • originality ≤ 15% per source        │
│   • ai-tells ≤ 5 hits                   │
│   • quality heuristics (variance, etc.) │
│   • EEAT signals                        │
│   • editorial-diff ≥ 25%                │
└────────┬────────────────────────────────┘
         │
         ▼
   blog/<slug>.html  ← English published
         │
         ▼
┌─────────────────────────────────────────┐
│  translate.mjs                          │
│   ES, FR, DE, PT (parallel calls)       │
│   translation-quality check             │
│   retry if fails                        │
└────────┬────────────────────────────────┘
         │
         ▼
   {es,fr,de,pt}/blog/<slug>.html
         │
         ▼
   git commit + push → Cloudflare deploy
```

## Setup (one-time)

On the server (or Mac with Ollama installed):

```bash
# 1. Install Ollama + a 70B model (Llama 3.3 recommended)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.3:70b
ollama serve  # in background

# 2. Install Node deps
cd content-pipeline
pnpm install   # or npm install

# 3. Configure env
cp .env.example .env
# Edit .env with your Ollama URL, SMTP credentials

# 4. Verify Ollama is reachable
pnpm ollama:check
```

## Usage

### Generate a draft

```bash
# Pick next status:idea topic from topics.yaml and draft it
pnpm draft-next

# Or draft a specific topic by slug
pnpm draft warm-up-transactional-sender
```

This runs the 5-pass pipeline:
1. **Research** — extract structured facts from sources_hint
2. **Outline** — propose unique structure (varies per article)
3. **Draft** — write body using voice.md + humanizer.md + product-context.md
4. **Style-align** — fix any AI-tells caught by checks/ai-tells.mjs
5. **SEO** — generate frontmatter (title, description, slug, etc.)

Saves to `drafts/<slug>.md` and `drafts/<slug>.original.md` (immutable snapshot).

### Edit the draft (≥25% diff)

```bash
$EDITOR drafts/warm-up-transactional-sender.md
```

What to add (the "human pass"):
- Real customer quote (anonymized OK)
- Specific SwiftMail metric or screenshot
- Founder anecdote
- Disagreement or twist on conventional advice
- Section restructure if needed

### Re-check before publish

```bash
pnpm check warm-up-transactional-sender
```

Shows pass/fail for each gate. Iterate on the markdown until all green.

### Translate

```bash
# All 4 languages
pnpm translate warm-up-transactional-sender

# Specific languages
pnpm translate warm-up-transactional-sender es,fr
```

Saves to `drafts/<slug>.<lang>.md` for review.

### Publish

```bash
# English only
pnpm publish warm-up-transactional-sender

# English + all translations
pnpm publish warm-up-transactional-sender --langs=all

# Skip pre-publish gate (use sparingly — only when checks are wrong about your edits)
pnpm publish warm-up-transactional-sender --skip-checks

# Render only, no git push (dry run)
pnpm publish warm-up-transactional-sender --no-push
```

What it does:
1. Runs pre-publish gate (5 checks)
2. Renders markdown → HTML for each language
3. Updates `blog/index.html` and `{lang}/blog/index.html` with new card
4. Commits + pushes to `main` → Cloudflare Pages auto-deploys (1-2 min)

### Daily report email

```bash
pnpm report
```

Set up as cron on the server:
```cron
0 9 * * *  cd /srv/swiftmail-landing/content-pipeline && pnpm report
```

Sends summary of last 24h to `REPORT_TO` (your Gmail). Without SMTP creds,
prints to stdout.

## Files

```
content-pipeline/
├── voice.md             — SwiftMail brand voice, banned phrases, sentence patterns
├── humanizer.md         — universal "doesn't read like AI" rules
├── product-context.md   — SwiftMail features, real metrics, customer profile
├── translation-rules.md — what to preserve vs translate
├── voice-{es,fr,de,pt}.md — per-language voice adaptations
├── i18n.yaml            — UI strings × 5 langs (chip labels, buttons, etc.)
├── topics.yaml          — 50+ queued topics with metadata
├── examples/            — best existing articles (few-shot for LLM)
├── drafts/              — output (human-editable) + .original.md snapshots
├── logs/                — JSONL pipeline activity, read by daily-report
├── lib/
│   ├── ollama-client.mjs     — thin Ollama HTTP client
│   ├── markdown-render.mjs   — md → blog post HTML
│   ├── slug.mjs              — slug helpers
│   ├── frontmatter.mjs       — minimal YAML frontmatter parser
│   └── log.mjs               — JSONL event log
├── checks/
│   ├── ai-tells.mjs          — banned phrases, em-dash overuse, etc.
│   ├── originality.mjs       — n-gram similarity vs sources
│   ├── quality-heuristics.mjs — sentence variance, specificity, first-person
│   ├── eeat.mjs              — author byline, citations, unique-data, internal links
│   ├── editorial-diff.mjs    — ≥25% diff vs LLM original
│   └── translation-quality.mjs — brand-name/acronym/URL/heading parity
├── pipeline.mjs         — main: draft / draft-next / check / status
├── translate.mjs        — translation orchestrator
├── publish.mjs          — pre-publish gate + HTML render + git push
├── daily-report.mjs     — aggregate logs, email digest
└── package.json
```

## How the gates protect you

The pipeline is built on a thesis: **Google doesn't penalize "AI-generated"
content per se — it penalizes low-quality, non-helpful, scaled-spam patterns.**
The 5 hard gates target those failure modes directly:

| Gate | What it prevents |
|---|---|
| Originality | Paraphrased copies of source material (copyright + Google duplicate-content) |
| AI-tells | Generic ChatGPT prose patterns ("delve", em-dash overuse, bullet spam) |
| Quality heuristics | Templated AI sentences (low variance, vague generics, no first-person) |
| EEAT signals | Missing author, no citations, no unique data, no internal authority |
| Editorial diff | Skipped human pass (the make-it-yours step) |

A draft that passes all 5 gates **looks and reads like authored content** — because
it had to be authored to pass them. The AI is a research assistant + first-draft
generator; the human pass is non-negotiable.

A 6th SOFT gate (AI detector probability) can be added per topic via `humor_level`
or other flags — it logs warnings but never blocks (false positives are too high).

## Cost

Per article (English + 4 translations) at ~5k words:
- **Ollama 70B w/ GPU**: $0 (compute), ~3-5 min/article
- **Ollama 8B on CPU only**: $0, ~10-25 min/article. Workable as overnight cron, slow for interactive use.
- **Anthropic API** (Claude Sonnet 4.5): ~$0.30-0.50/article

At 1-2 articles/day, monthly: 0$ if all-Ollama, or ~$15-25/mo if hybrid.

## CPU-only Ollama notes

If Ollama runs on a CPU-only host (no GPU offload):

- **Model choice matters.** llama3.1:8b reliable on CPU. qwen2.5:14b risks OOM
  on hosts with <16 GB RAM. qwen3:8b runs but uses thinking-mode that
  consumes most max_tokens on internal reasoning — pipeline falls back to
  surfacing reasoning text as content if main field is empty.
- **Context window is 4096 by default.** Pipeline uses voice-compact.md
  (not the full voice.md) for system prompt to fit prompt + outline + facts
  inside the window.
- **Token output speed: 5-15 tok/sec.** A 1500-word article (~2200 tokens)
  takes ~3-7 min per phase × 5 phases = 15-35 min total per draft.
- **Set OLLAMA_TIMEOUT_MS** env var if you need longer than 30 min default
  (most CPU drafts complete inside that window).
- **Run via cron at night** (e.g. 03:00) if pipeline is shared with
  other server workloads.

## Troubleshooting

**Ollama not reachable:**
- Verify `OLLAMA_URL` env var
- `curl $OLLAMA_URL/api/tags` should return JSON
- If on remote server: `ssh -L 11434:localhost:11434 server` to tunnel

**Model not found:**
- `ollama list` shows what's loaded
- `ollama pull <model>` downloads (Llama 3.3 70B = ~40 GB)

**Pre-publish gate keeps failing:**
- Read the feedback — it lists exactly what to fix
- If checks are wrong about your edits, use `--skip-checks` (sparingly)
- Tune thresholds in `checks/*.mjs` if you find them too strict for your style

**Translations failing quality check:**
- Usually because brand names got translated. Check brand-name preservation list.
- One auto-retry happens; if still fails, saved with `translation_status: needs_review`.

**SMTP daily report not sending:**
- Verify Gmail app password (not your regular password)
- Test: `pnpm report` will fall back to stdout if creds missing
