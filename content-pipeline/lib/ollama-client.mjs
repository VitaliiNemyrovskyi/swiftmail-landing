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

  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Ollama returned empty content: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return content;
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
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  return json.choices[0].message.content;
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
