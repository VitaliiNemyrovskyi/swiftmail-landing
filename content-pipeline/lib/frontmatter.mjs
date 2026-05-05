// Minimal YAML frontmatter parser/serializer for our markdown drafts.
// We don't need a full YAML parser — frontmatter fields are flat key:value.
//
// Format:
//   ---
//   title: Article title
//   slug: article-title
//   category: deliverability
//   date: 2026-05-05
//   author: Vitalii Nemyrovskyi
//   read_time: 8
//   ---
//
//   Body markdown follows...

const FM_DELIM = '---';

/**
 * Parse markdown into { frontmatter: object, body: string }.
 * @param {string} markdown
 * @returns {{ frontmatter: Record<string, string|number>, body: string }}
 */
export function parse(markdown) {
  if (!markdown.startsWith(`${FM_DELIM}\n`)) {
    return { frontmatter: {}, body: markdown };
  }
  const endIdx = markdown.indexOf(`\n${FM_DELIM}\n`, FM_DELIM.length + 1);
  if (endIdx === -1) {
    return { frontmatter: {}, body: markdown };
  }
  const fmStr = markdown.slice(FM_DELIM.length + 1, endIdx);
  const body = markdown.slice(endIdx + FM_DELIM.length + 2);

  const frontmatter = {};
  for (const line of fmStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // numeric coerce
    if (/^-?\d+$/.test(value)) value = Number(value);
    if (/^-?\d+\.\d+$/.test(value)) value = Number(value);
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

/**
 * Serialize { frontmatter, body } back to a markdown string.
 * @param {object} opts
 * @param {Record<string, string|number>} opts.frontmatter
 * @param {string} opts.body
 * @returns {string}
 */
export function serialize({ frontmatter, body }) {
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    const needsQuotes =
      typeof v === 'string' &&
      (v.includes(':') || v.includes('#') || /^[\s'"]/.test(v));
    const val = needsQuotes ? `"${String(v).replace(/"/g, '\\"')}"` : String(v);
    return `${k}: ${val}`;
  });
  return `${FM_DELIM}\n${fmLines.join('\n')}\n${FM_DELIM}\n\n${body}`;
}

/**
 * Validate that required frontmatter fields are present.
 * Throws on missing fields.
 *
 * @param {Record<string, any>} fm
 * @param {string[]} required
 */
export function assertFields(fm, required) {
  const missing = required.filter((k) => fm[k] === undefined || fm[k] === '');
  if (missing.length > 0) {
    throw new Error(`Missing frontmatter fields: ${missing.join(', ')}`);
  }
}
