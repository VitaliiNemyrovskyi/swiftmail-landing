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
  return streamChat({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs });
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

  return streamChat({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs });
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
async function streamChat({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs }) {
  if ((process.env.LLM_PROVIDER || 'ollama').toLowerCase() === 'groq') {
    return streamChatGroq({ messages, temperature, maxTokens, timeoutMs, model });
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
  // when chunked calls fire back-to-back (e.g. translate.mjs 9-chunk loops).
  // Groq returns "Please try again in X.Ys" — parse it, sleep, retry. The
  // window is rolling, so a single retry may still bump into accumulated
  // budget — try up to 5 times with the server-recommended delay each.
  let res;
  let lastBody = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetchGroq();
    if (res.status !== 429) break;
    lastBody = await res.text();
    const m = /try again in ([\d.]+)s/i.exec(lastBody);
    const waitSec = m ? Math.min(parseFloat(m[1]) + 2, 90) : 30;
    console.log(`     · Groq 429 (attempt ${attempt + 1}/5) — waiting ${waitSec.toFixed(1)}s…`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
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
 * Health-check. For Groq mode, just verifies API key is present and the
 * /openai/v1/models endpoint responds — no need to ping localhost.
 * @returns {Promise<boolean>}
 */
export async function ping({ url = DEFAULT_URL } = {}) {
  if ((process.env.LLM_PROVIDER || 'ollama').toLowerCase() === 'groq') {
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
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
