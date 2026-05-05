// Simple JSONL logger. Writes events to logs/pipeline-YYYY-MM-DD.jsonl.
// daily-report.mjs reads these and emails a digest.
//
// Why JSONL?
//   - Append-only, never corrupted
//   - One event per line, easy grep + jq
//   - daily-report.mjs reads last 24h slice via tail+head

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function todayPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `pipeline-${today}.jsonl`);
}

/**
 * Append an event to today's log.
 * @param {string} event - e.g. 'draft.start', 'draft.done', 'check.failed'
 * @param {Record<string, any>} [data]
 */
export function log(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  fs.appendFileSync(todayPath(), JSON.stringify(entry) + '\n');
}

/**
 * Read all events from a date window. Default: last 24 hours from `now`.
 * @param {object} [opts]
 * @param {Date} [opts.since]
 * @param {Date} [opts.until]
 * @returns {Array<{ts: string, event: string, [k: string]: any}>}
 */
export function readEvents({ since, until = new Date() } = {}) {
  const sinceDate = since || new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Iterate over date range, collecting jsonl files
  const events = [];
  const cursor = new Date(sinceDate);
  while (cursor <= until) {
    const day = cursor.toISOString().slice(0, 10);
    const filePath = path.join(LOG_DIR, `pipeline-${day}.jsonl`);
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = new Date(entry.ts);
          if (ts >= sinceDate && ts <= until) events.push(entry);
        } catch {
          // skip malformed
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return events;
}

/** Count events by type within a window. */
export function summary({ since } = {}) {
  const events = readEvents({ since });
  const counts = {};
  for (const e of events) {
    counts[e.event] = (counts[e.event] || 0) + 1;
  }
  return { total: events.length, byEvent: counts, events };
}
