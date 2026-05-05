#!/usr/bin/env node
// daily-report.mjs — aggregate yesterday's pipeline activity, email digest.
//
// Cron suggestion (on the server):
//   0 9 * * *  cd /srv/swiftmail-landing/content-pipeline && node daily-report.mjs
//
// Email setup:
//   Uses Gmail SMTP via app password (free, simple, 500/day limit — plenty).
//   Set in .env:
//     SMTP_USER=vitalii.nemyrovskyi@gmail.com
//     SMTP_PASS=<16-char app password from myaccount.google.com/apppasswords>
//     REPORT_TO=vitalii.nemyrovskyi@gmail.com
//
// Without SMTP creds: falls back to printing the report to stdout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import yaml from 'yaml';
import { readEvents } from './lib/log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const REPORT_TO = process.env.REPORT_TO || 'vitalii.nemyrovskyi@gmail.com';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);

(async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = readEvents({ since });

  const report = buildReport(events);

  if (SMTP_USER && SMTP_PASS) {
    await sendEmail(report);
    console.log(`✓ Daily report sent to ${REPORT_TO}`);
  } else {
    console.log('⚠ SMTP credentials missing — printing report to stdout:\n');
    console.log(report.plaintext);
  }
})().catch((err) => {
  console.error('✗ daily-report failed:', err.message);
  process.exit(1);
});

// ── Build report ─────────────────────────────────────────────────────

function buildReport(events) {
  const today = new Date().toISOString().slice(0, 10);

  // Bucket events
  const drafts = events.filter((e) => e.event === 'draft.done');
  const draftStarts = events.filter((e) => e.event === 'draft.start');
  const draftErrors = events.filter((e) => e.event === 'error' && e.command === 'draft');
  const checks = events.filter((e) => e.event === 'check.done');
  const translateDone = events.filter((e) => e.event === 'translate.done');
  const translateErrors = events.filter((e) => e.event === 'translate.error');
  const translateRetries = events.filter((e) => e.event === 'translate.retry');
  const publishes = events.filter((e) => e.event === 'publish.done');
  const publishGates = events.filter((e) => e.event === 'publish.gate');
  const publishErrors = events.filter((e) => e.event === 'publish.error');

  // Topics backlog
  const topics = yaml.parse(fs.readFileSync(path.join(ROOT, 'topics.yaml'), 'utf8'));
  const byStatus = {};
  for (const t of topics) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  // Build summary
  const summary = {
    date: today,
    drafts: drafts.length,
    draftErrors: draftErrors.length,
    publishes: publishes.length,
    publishGatesPassed: publishGates.filter((g) => g.passed).length,
    publishGatesFailed: publishGates.filter((g) => !g.passed).length,
    publishErrors: publishErrors.length,
    translations: translateDone.length,
    translationErrors: translateErrors.length,
    translationRetries: translateRetries.length,
    backlogIdea: byStatus.idea || 0,
    backlogTotal: topics.length,
  };

  // Build plain-text version (also used as fallback)
  const plaintext = formatPlainText(summary, drafts, publishes, publishGates, draftErrors, publishErrors);
  const html = formatHtml(summary, drafts, publishes, publishGates, draftErrors, publishErrors);

  return { summary, plaintext, html, subject: `Pipeline ${today} · ${summary.drafts} drafts, ${summary.publishes} published` };
}

function formatPlainText(s, drafts, publishes, gates, draftErrs, pubErrs) {
  const lines = [
    `SwiftMail Pipeline Report · ${s.date}`,
    '═══════════════════════════════════════',
    '',
    'Today\'s activity',
    '────────────────',
    `  Drafts created:        ${s.drafts}${s.draftErrors > 0 ? ` (${s.draftErrors} errors)` : ''}`,
    `  Articles published:    ${s.publishes}`,
    `  Translations done:     ${s.translations}${s.translationErrors > 0 ? ` (${s.translationErrors} errors)` : ''}`,
    `  Pre-publish gate:      ${s.publishGatesPassed} passed, ${s.publishGatesFailed} failed`,
    '',
  ];

  if (drafts.length > 0) {
    lines.push('Drafts created');
    lines.push('──────────────');
    for (const d of drafts) lines.push(`  • ${d.slug}`);
    lines.push('');
  }

  if (publishes.length > 0) {
    lines.push('Published');
    lines.push('─────────');
    for (const p of publishes) lines.push(`  • ${p.slug} (${(p.langs || ['en']).join(', ')})`);
    lines.push('');
  }

  if (gates.filter((g) => !g.passed).length > 0) {
    lines.push('⚠ Pre-publish gate failures');
    lines.push('───────────────────────────');
    for (const g of gates.filter((g) => !g.passed)) {
      lines.push(`  • ${g.slug}: ${g.aiTellsHits} ai-tells, ${g.qualityFails} quality fails, ${g.eeatFails} eeat fails, ${(g.editorialDiff * 100).toFixed(0)}% diff`);
    }
    lines.push('');
  }

  if (draftErrs.length + pubErrs.length > 0) {
    lines.push('✗ Errors');
    lines.push('────────');
    for (const e of [...draftErrs, ...pubErrs]) {
      lines.push(`  • ${e.slug || e.command}: ${e.error}`);
    }
    lines.push('');
  }

  lines.push('Topic backlog');
  lines.push('─────────────');
  lines.push(`  Topics ready (status:idea):  ${s.backlogIdea}`);
  lines.push(`  Total in backlog:            ${s.backlogTotal}`);
  lines.push('');
  lines.push('— SwiftMail content pipeline');

  return lines.join('\n');
}

function formatHtml(s, drafts, publishes, gates, draftErrs, pubErrs) {
  const failedGates = gates.filter((g) => !g.passed);
  const errors = [...draftErrs, ...pubErrs];

  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #0f172a; background: #f7f9fb;">
  <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
    <h1 style="margin: 0 0 4px; font-size: 22px; letter-spacing: -0.02em;">SwiftMail Pipeline</h1>
    <p style="margin: 0 0 24px; color: #64748b; font-size: 14px;">Daily report · ${s.date}</p>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
      <tr><td style="padding: 6px 0; color: #64748b;">Drafts created</td><td style="text-align: right; font-weight: 600;">${s.drafts}${s.draftErrors > 0 ? ` <span style="color: #dc2626;">(${s.draftErrors} err)</span>` : ''}</td></tr>
      <tr><td style="padding: 6px 0; color: #64748b;">Published</td><td style="text-align: right; font-weight: 600;">${s.publishes}</td></tr>
      <tr><td style="padding: 6px 0; color: #64748b;">Translations</td><td style="text-align: right; font-weight: 600;">${s.translations}${s.translationErrors > 0 ? ` <span style="color: #dc2626;">(${s.translationErrors} err)</span>` : ''}</td></tr>
      <tr><td style="padding: 6px 0; color: #64748b;">Gates passed</td><td style="text-align: right; font-weight: 600; color: ${s.publishGatesFailed > 0 ? '#ea580c' : '#16a34a'};">${s.publishGatesPassed}/${s.publishGatesPassed + s.publishGatesFailed}</td></tr>
    </table>

    ${drafts.length > 0 ? `
    <h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin: 24px 0 8px;">Drafts created</h2>
    <ul style="margin: 0; padding-left: 18px;">
      ${drafts.map((d) => `<li style="margin: 4px 0;">${escape(d.slug)}</li>`).join('')}
    </ul>` : ''}

    ${publishes.length > 0 ? `
    <h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin: 24px 0 8px;">Published</h2>
    <ul style="margin: 0; padding-left: 18px;">
      ${publishes.map((p) => `<li style="margin: 4px 0;"><a href="https://swift-mail.app/blog/${escape(p.slug)}.html" style="color: #c2410c;">${escape(p.slug)}</a> <span style="color: #94a3b8; font-size: 12px;">(${(p.langs || ['en']).join(', ')})</span></li>`).join('')}
    </ul>` : ''}

    ${failedGates.length > 0 ? `
    <h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #ea580c; margin: 24px 0 8px;">⚠ Pre-publish failures</h2>
    <ul style="margin: 0; padding-left: 18px;">
      ${failedGates.map((g) => `<li style="margin: 4px 0;">${escape(g.slug)}: ${g.aiTellsHits} ai-tells · ${g.qualityFails} quality · ${g.eeatFails} eeat · ${(g.editorialDiff * 100).toFixed(0)}% diff</li>`).join('')}
    </ul>` : ''}

    ${errors.length > 0 ? `
    <h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #dc2626; margin: 24px 0 8px;">✗ Errors</h2>
    <ul style="margin: 0; padding-left: 18px; color: #475569; font-size: 13px;">
      ${errors.map((e) => `<li style="margin: 4px 0;">${escape(e.slug || e.command || '?')}: ${escape(e.error || 'unknown')}</li>`).join('')}
    </ul>` : ''}

    <h2 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin: 24px 0 8px;">Backlog</h2>
    <table style="width: 100%; border-collapse: collapse;">
      <tr><td style="padding: 4px 0; color: #64748b;">Ready (status:idea)</td><td style="text-align: right; font-weight: 600;">${s.backlogIdea}</td></tr>
      <tr><td style="padding: 4px 0; color: #64748b;">Total in topics.yaml</td><td style="text-align: right;">${s.backlogTotal}</td></tr>
    </table>

    <p style="margin: 32px 0 0; color: #94a3b8; font-size: 12px; text-align: center;">— SwiftMail content pipeline</p>
  </div>
</body></html>`;
}

function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Email sender ─────────────────────────────────────────────────────

async function sendEmail({ subject, plaintext, html }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"SwiftMail Pipeline" <${SMTP_USER}>`,
    to: REPORT_TO,
    subject,
    text: plaintext,
    html,
  });
}
