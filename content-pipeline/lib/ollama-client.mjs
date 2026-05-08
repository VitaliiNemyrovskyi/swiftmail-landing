// Thin Ollama HTTP client. Targets the OpenAI-compatible /v1/chat/completions
// endpoint Ollama exposes (https://github.com/ollama/ollama/blob/main/docs/openai.md).
//
// Why not use openai-js or another SDK?  We need ~50 lines of fetch + JSON.
// A dependency would be more code to lint than the impl itself.
//
// Env:
//   OLLAMA_URL   — base URL (e.g. http://localhost:11434)
//   OLLAMA_MODEL — model name (e.g. llama3.3:70b)
//
// Usage:
//   import { complete, chat } from './lib/ollama-client.mjs';
//   const text = await complete({ system: '...', user: '...' });

// Override Node's undici fetch timeouts. Defaults are 5min for both
// headersTimeout and bodyTimeout — bites us on CPU Ollama where the
// draft phase's prompt eval can take ≥5min before the first response
// chunk arrives. Symptom: "fetch failed" exactly 5m1s into draft.
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({
  headersTimeout: 30 * 60 * 1000, // 30 min
  bodyTimeout:    30 * 60 * 1000, // 30 min
  keepAliveTimeout: 60 * 1000,
}));

const DEFAULT_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.3:70b';

/**
 * Single-shot completion. Returns the assistant's text reply.
 * @param {object} opts
 * @param {string} opts.system - System prompt (voice/humanizer/etc.)
 * @param {string} opts.user - User message
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=4096]
 * @param {string} [opts.model]
 * @param {string} [opts.url]
 * @returns {Promise<string>}
 */
export async function complete({
  system,
  user,
  temperature = 0.7,
  maxTokens = 4096,
  model = DEFAULT_MODEL,
  url = DEFAULT_URL,
}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  // CPU-only Ollama hosts can take 10+ min for ~2000-token completions.
  // Override via OLLAMA_TIMEOUT_MS env var.
  const timeoutMs = process.env.OLLAMA_TIMEOUT_MS
    ? Number(process.env.OLLAMA_TIMEOUT_MS)
    : 30 * 60 * 1000; // 30 min

  // Ollama default n_ctx=4096 too small for draft phase. 8192 fits.
  const numCtx = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : 8192;

  // CRITICAL: stream=true avoids Node's undocumented 5-min bodyTimeout.
  // With stream=false, Ollama buffers all tokens then writes one chunk —
  // if generation > 5 min, Node aborts with "fetch failed" before chunk arrives.
  // Streaming chunks arrive every few hundred ms, keeping the body alive.
  return streamChatWithFallback({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs });
}

/**
 * Multi-turn chat. Returns the assistant's reply.
 * @param {object} opts
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} opts.messages
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=4096]
 * @param {string} [opts.model]
 * @param {string} [opts.url]
 * @returns {Promise<string>}
 */
export async function chat({
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  model = DEFAULT_MODEL,
  url = DEFAULT_URL,
}) {
  const timeoutMs = process.env.OLLAMA_TIMEOUT_MS
    ? Number(process.env.OLLAMA_TIMEOUT_MS)
    : 30 * 60 * 1000;
  const numCtx = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : 8192;

  return streamChatWithFallback({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs });
}

/**
 * Streaming chat — accumulates tokens from NDJSON response chunks.
 * Keeps the HTTP body alive while CPU model generates, avoiding
 * Node's 5-min bodyTimeout that bites on long stream=false requests.
 *
 * Dispatches to Groq cloud (OpenAI-compatible API) when LLM_PROVIDER=groq
 * is set in env. Same input shape, same string return type — drop-in.
 * Groq runs the same llama-family models 50-300× faster on optimized
 * hardware, eliminating the OOM/timeout issues we hit on CPU Ollama.
 */
/**
 * Provider chain for auto-fallback. Order is preference: try first, on
 * failure (429 / 5xx / connection / empty) try next. The chain is
 * filtered at runtime to only include providers whose API key env is
 * set, so a missing GEMINI_API_KEY just skips that link silently.
 *
 * Override via env LLM_PROVIDER_CHAIN (comma-separated). When the
 * chain fully exhausts, we throw the last error so the caller can fall
 * through to its own retry / abort logic.
 *
 * Single-provider mode (legacy): if LLM_PROVIDER is set but
 * LLM_PROVIDER_CHAIN is not, use ONLY that provider (mirrors the old
 * pre-2026-05-08 behaviour). Setting LLM_PROVIDER_CHAIN explicitly
 * activates the new fallback flow.
 */
function getProviderChain() {
  if (process.env.LLM_PROVIDER_CHAIN) {
    return process.env.LLM_PROVIDER_CHAIN
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
  }
  // Legacy mode: single provider from LLM_PROVIDER.
  return [(process.env.LLM_PROVIDER || 'ollama').toLowerCase()];
}

/**
 * Map provider name → env var that holds its API key. Empty key means
 * the provider should be skipped (e.g. GEMINI_API_KEY unset → don't try).
 * Ollama is always-considered-available since it has no auth.
 */
function providerKeyEnv(provider) {
  switch (provider) {
    case 'groq':   return 'GROQ_API_KEY';
    case 'glm':    return 'GLM_API_KEY';
    case 'gemini': return 'GEMINI_API_KEY';
    case 'ollama': return null;
    default:       return null;
  }
}

/**
 * Per-provider transient-failure markers. A failure of these kinds
 * triggers fallback to the next provider in the chain. Anything else
 * (auth_error / config typo / programming bug) is fatal — fail loud.
 */
function isTransientProviderError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('429')) return true;
  if (msg.includes('rate limit') || msg.includes('rate_limit')) return true;
  if (msg.includes(' 5')) {
    // server_error 500-599 — match digits after space + status-like prefix
    if (/(?:groq|glm|gemini|ollama) 5\d\d/.test(err.message || '')) return true;
  }
  if (msg.includes('terminated') || msg.includes('connection') || msg.includes('econnrefused')) return true;
  if (msg.includes('econnreset') || msg.includes('enotfound')) return true;
  if (msg.includes('empty content')) return true;
  if (msg.includes('timeout') || msg.includes('aborted')) return true;
  return false;
}

async function streamChat({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs }) {
  const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'groq') {
    return streamChatGroq({ messages, temperature, maxTokens, timeoutMs, model });
  }
  if (provider === 'glm') {
    return streamChatGlm({ messages, temperature, maxTokens, timeoutMs, model });
  }
  if (provider === 'gemini') {
    return chatGemini({ messages, temperature, maxTokens, timeoutMs, model });
  }
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: {
        temperature,
        num_predict: maxTokens,
        num_ctx: numCtx,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
  }

  // Ollama streams NDJSON: one JSON object per line.
  // Each line: { message: { content: "<delta>", role: "assistant" }, done: false }
  // Final line:  { ..., done: true, total_duration, eval_count, ... }
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) assembled += obj.message.content;
        if (obj.message?.reasoning) assembled += obj.message.reasoning;
        if (obj.error) throw new Error(`Ollama stream error: ${obj.error}`);
        if (obj.done && obj.done_reason && obj.done_reason !== 'stop' && obj.done_reason !== 'length') {
          throw new Error(`Ollama done with reason: ${obj.done_reason}`);
        }
      } catch (err) {
        if (err.message.startsWith('Ollama')) throw err;
        // Malformed JSON line — skip (rare, defensive)
      }
    }
  }

  if (!assembled) throw new Error('Ollama stream returned empty content');
  return assembled;
}

/**
 * Groq cloud variant — OpenAI-compatible chat completions API at
 * https://api.groq.com/openai/v1/chat/completions. Uses SSE streaming.
 *
 * Model picked from GROQ_MODEL env (default: llama-3.3-70b-versatile —
 * Groq free tier, 128k ctx, way smarter than llama3.1:8b we run locally).
 * GROQ_API_KEY must be set; throws otherwise.
 *
 * Drop-in replacement for streamChat — same input fields used, same
 * string return.
 */
async function streamChatGroq({ messages, temperature, maxTokens, timeoutMs, model: callerModel }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY missing — set in .env or unset LLM_PROVIDER');
  // Caller can override model (e.g. translate.mjs uses 8b to fit TPM limits);
  // otherwise pick from env or default to versatile 70b for drafting.
  // Groq IDs use dots/hyphens like "llama-3.1-8b-instant"; Ollama uses
  // colons like "llama3.1:8b". Detect by absence of ":" (the Ollama tag
  // separator) — Groq ids never contain it.
  const looksLikeGroqId = callerModel && !callerModel.includes(':');
  const model = (looksLikeGroqId ? callerModel : null)
    || process.env.GROQ_MODEL
    || 'llama-3.3-70b-versatile';

  // Free tier TPM (tokens per minute) rolling-window limits trigger 429s
  // when chunked calls fire back-to-back. Groq returns "Please try again
  // in X.Ys" — parse, sleep, retry.
  //
  // Retry budget reduced 5→2 on 2026-05-08: with the new fallback chain
  // (groq→glm→gemini) it's faster + more useful to fall through to the
  // next provider after 2 in-window retries than burn 2.5 min retrying
  // the same daily-exhausted provider. The chain wrapper above will
  // try the next link if this provider keeps 429ing.
  let res;
  let lastBody = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetchGroq();
    if (res.status !== 429) break;
    lastBody = await res.text();
    // Groq message can be "try again in 11.808s" OR "in 3m11.808s".
    // For minute-scale waits, fall through to the chain rather than
    // burning a long sleep here.
    const m = /try again in ([\d.]+)s/i.exec(lastBody);
    const waitSec = m ? parseFloat(m[1]) : 30;
    if (waitSec > 60) {
      // Long wait → don't bother retrying, let chain fall through.
      break;
    }
    const safeSec = Math.min(waitSec + 2, 60);
    console.log(`     · Groq 429 (attempt ${attempt + 1}/2) — waiting ${safeSec.toFixed(1)}s…`);
    await new Promise((r) => setTimeout(r, safeSec * 1000));
  }

  if (!res.ok) {
    const body = res.status === 429 ? lastBody : await res.text();
    throw new Error(`Groq ${res.status}: ${body.slice(0, 500)}`);
  }

  async function fetchGroq() {
    return fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  // Parse Server-Sent Events. Each event: "data: {...json...}\n" with
  // a final "data: [DONE]" sentinel. Each JSON has shape
  // { choices: [{ delta: { content: "..." } }] }.
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      if (!data) continue;
      try {
        const obj = JSON.parse(data);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) assembled += delta;
        const errMsg = obj.error?.message;
        if (errMsg) throw new Error(`Groq stream error: ${errMsg}`);
      } catch (err) {
        if (err.message.startsWith('Groq')) throw err;
        // Malformed SSE line — skip (rare, defensive)
      }
    }
  }

  if (!assembled) throw new Error('Groq stream returned empty content');
  return assembled;
}

/**
 * GLM (z.ai) variant — OpenAI-compatible chat completions API at
 * https://api.z.ai/api/paas/v4/chat/completions. SSE streaming.
 *
 * Default model `glm-4.7-flash` is permanently free per Zhipu AI's
 * pricing page (https://docs.z.ai/guides/overview/pricing). No
 * published RPM at time of writing — server just 429s when overloaded.
 *
 * Different training distribution from Groq's llama-family (Zhipu AI is
 * a Chinese lab, distinct priors from Western Llama/OpenAI stacks),
 * which is the reason we add it as an alternative provider rather than
 * just a fallback URL.
 *
 * Drop-in replacement for streamChat — same input fields, same string return.
 */
async function streamChatGlm({ messages, temperature, maxTokens, timeoutMs, model: callerModel }) {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) throw new Error('GLM_API_KEY missing — set in .env or unset LLM_PROVIDER');

  // Caller can override model with a glm-* id; otherwise pick from env
  // or default to the free flash. GLM model ids start with "glm-".
  const looksLikeGlmId = callerModel && callerModel.startsWith('glm-');
  const model = (looksLikeGlmId ? callerModel : null)
    || process.env.GLM_MODEL
    || 'glm-4.7-flash';

  const baseUrl = process.env.GLM_BASE_URL || 'https://api.z.ai/api/paas/v4';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      // CRITICAL: disable thinking-mode preamble. GLM 4.5/4.7-flash by
      // default streams `delta.reasoning_content` chunks BEFORE the
      // actual `delta.content` — and the reasoning eats the entire
      // max_tokens budget on small calls (we'd hit max_tokens on
      // reasoning, never reach content, and our SSE parser only watches
      // `delta.content` so `assembled` stayed empty → "GLM stream
      // returned empty content" thrown). With thinking disabled the
      // model produces visible content immediately. Verified 2026-05-08
      // against /api/paas/v4/chat/completions.
      thinking: { type: 'disabled' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GLM ${res.status}: ${body.slice(0, 500)}`);
  }

  // Same SSE parsing as Groq — both speak OpenAI-format streaming.
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      if (!data) continue;
      try {
        const obj = JSON.parse(data);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) assembled += delta;
        const errMsg = obj.error?.message;
        if (errMsg) throw new Error(`GLM stream error: ${errMsg}`);
      } catch (err) {
        if (err.message.startsWith('GLM')) throw err;
        // Malformed SSE line — skip (rare, defensive)
      }
    }
  }

  if (!assembled) throw new Error('GLM stream returned empty content');
  return assembled;
}

/**
 * Gemini variant — Google `generateContent` (non-streaming). We use the
 * non-streaming endpoint here even though Groq/GLM use SSE: Gemini's
 * SSE format diverges from OpenAI-style enough that a separate parser
 * would be its own bug surface, and Gemini's responses are quick
 * enough (<30s for our use cases) that streaming buys little. We still
 * return a string to match the streamChatGroq/Glm contract.
 *
 * Auth: `x-goog-api-key` header (NOT URL query param — that leaks to
 * logs). Confirmed working against /v1beta on 2026-05-08.
 *
 * Free tier: gemini-2.0-flash is gratis under quota; paid above.
 */
async function chatGemini({ messages, temperature, maxTokens, timeoutMs, model: callerModel }) {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing — set in .env or remove gemini from LLM_PROVIDER_CHAIN');

  // Caller may pass a gemini-* id; otherwise use env override or default.
  const looksLikeGeminiId = callerModel && /^(gemini|models\/gemini)-/i.test(callerModel);
  const model = (looksLikeGeminiId ? callerModel : null)
    || process.env.GEMINI_MODEL
    || 'gemini-2.0-flash';

  // Transform OpenAI-style messages → Gemini's contents shape.
  // System prompt becomes top-level systemInstruction; rest are user/model
  // contents. Gemini doesn't support 'system' role inline.
  const sys = messages.find((m) => m.role === 'system')?.content;
  const userParts = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body = {
    contents: userParts,
    generationConfig: {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    },
  };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new Error('Gemini returned empty content');
  return text;
}

/**
 * Auto-fallback wrapper. Tries each provider in the chain in order;
 * on transient failure (429 / 5xx / timeout / empty) moves to the
 * next. Throws only when ALL providers in the chain failed.
 *
 * Why a top-level wrapper instead of changing streamChat: streamChat
 * is hot-path code paid 5+ times per article. Wrapping at the public
 * surface (complete / chat) keeps the hot path lean and the fallback
 * logic isolated to one place.
 *
 * Each provider gets ONE attempt here. The streamChatGroq function
 * itself retries up to 5 times for 429 with the server-recommended
 * wait — that's the per-provider RPM-bucket retry. The chain wrapper
 * handles the bigger "this provider is down or out of TPD" case by
 * jumping to the next.
 */
async function streamChatWithFallback(args) {
  const chain = getProviderChain();
  const errors = [];

  for (const provider of chain) {
    const keyEnv = providerKeyEnv(provider);
    if (keyEnv && !process.env[keyEnv]) {
      errors.push(`${provider}: skipped (${keyEnv} not set)`);
      continue;
    }

    // Temporarily override LLM_PROVIDER for this attempt so the existing
    // streamChat dispatcher routes correctly. Restore after.
    const originalProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = provider;

    try {
      const result = await streamChat(args);
      // Restore + announce winning provider in stderr (visible in logs).
      process.env.LLM_PROVIDER = originalProvider;
      if (chain.length > 1 && errors.length > 0) {
        // Only log fallback chatter when we actually fell through.
        console.log(`     · fallback succeeded via ${provider} (after: ${errors.join('; ')})`);
      }
      return result;
    } catch (err) {
      process.env.LLM_PROVIDER = originalProvider;
      const transient = isTransientProviderError(err);
      errors.push(`${provider}: ${err.message.slice(0, 200)}${transient ? '' : ' [fatal]'}`);
      if (!transient) throw err; // bail on auth / config errors immediately
    }
  }

  throw new Error(`All providers in chain failed:\n  - ${errors.join('\n  - ')}`);
}

/**
 * List available models. Useful for diagnostics / setup wizard.
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
export async function listModels({ url = DEFAULT_URL } = {}) {
  const res = await fetch(`${url}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const json = await res.json();
  return (json.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    family: m.details?.family,
    parameters: m.details?.parameter_size,
  }));
}

/**
 * Health-check. Cloud providers (groq / glm) verify API key + reach
 * their /models endpoint. Ollama-mode pings the local /api/tags.
 * @returns {Promise<boolean>}
 */
export async function ping({ url = DEFAULT_URL } = {}) {
  const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  if (provider === 'groq') {
    if (!process.env.GROQ_API_KEY) return false;
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  if (provider === 'glm') {
    if (!process.env.GLM_API_KEY) return false;
    try {
      const baseUrl = process.env.GLM_BASE_URL || 'https://api.z.ai/api/paas/v4';
      const res = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${process.env.GLM_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) return false;
    try {
      // GET /v1beta/models — quick auth probe, no actual generation.
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Run health-check against every provider in the chain and return
 * { provider: bool } map. Used for the pre-flight check at pipeline
 * startup so we can warn if a provider is down BEFORE burning ~30s
 * on a draft attempt that's going to fail.
 *
 * Used by pipeline.mjs's command-startup phase (CMDS_NEEDING_OLLAMA).
 */
export async function pingAll() {
  const chain = getProviderChain();
  const original = process.env.LLM_PROVIDER;
  const result = {};
  for (const provider of chain) {
    process.env.LLM_PROVIDER = provider;
    try {
      result[provider] = await ping();
    } catch {
      result[provider] = false;
    }
  }
  process.env.LLM_PROVIDER = original;
  return result;
}
