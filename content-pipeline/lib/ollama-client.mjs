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
 */
async function streamChat({ url, model, messages, temperature, maxTokens, numCtx, timeoutMs }) {
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
 * Health-check.
 * @returns {Promise<boolean>}
 */
export async function ping({ url = DEFAULT_URL } = {}) {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
