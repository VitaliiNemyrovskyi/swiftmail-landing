#!/usr/bin/env node
// setup-smtp.mjs — interactive setup for daily-report email
//
// Walks through:
//   1. Confirming the Gmail account
//   2. Opening myaccount.google.com/apppasswords with "SwiftMail" pre-filled
//   3. Reading the 16-char app password from stdin (hidden input)
//   4. Saving to .env (preserving any other env values)
//   5. Sending a test email to verify
//
// Usage:
//   node setup-smtp.mjs                  # interactive
//   node setup-smtp.mjs --test           # only re-test existing creds
//   node setup-smtp.mjs --print-env      # print resolved .env without changes

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');

const APP_PASSWORD_URL =
  'https://myaccount.google.com/apppasswords?app_name=SwiftMail';

const argv = new Set(process.argv.slice(2));

(async () => {
  banner();
  const env = readEnv();

  if (argv.has('--print-env')) {
    printEnv(env);
    return;
  }

  if (argv.has('--test')) {
    if (!env.SMTP_USER || !env.SMTP_PASS) {
      die('SMTP_USER and SMTP_PASS missing in .env. Run without --test first.');
    }
    await testEmail(env);
    return;
  }

  // Interactive flow
  console.log('  Setup will configure Gmail SMTP for daily-report.mjs.\n');

  // Step 1: Gmail address
  const defaultUser = env.SMTP_USER || 'vitalii.nemyrovskyi@gmail.com';
  const smtpUser = (await prompt(`  Gmail address [${defaultUser}]: `)).trim() || defaultUser;
  if (!/@gmail\.com$/i.test(smtpUser) && !/@googlemail\.com$/i.test(smtpUser)) {
    console.log(`  ⚠  ${smtpUser} doesn't look like a Gmail/Workspace address. Continuing anyway…`);
  }

  // Step 2: 2FA reminder
  console.log(`
  ┌─ Prerequisites ──────────────────────────────────────────────────┐
  │  Gmail app passwords require 2-Step Verification on the account. │
  │                                                                  │
  │  If 2FA isn't enabled yet:                                       │
  │    https://myaccount.google.com/signinoptions/two-step-verification │
  │                                                                  │
  │  Once 2FA is on, app password creation works.                    │
  └──────────────────────────────────────────────────────────────────┘
`);

  await prompt('  Press Enter when 2FA is confirmed enabled…');

  // Step 3: Open the app password page
  console.log(`
  ┌─ Generate the app password ──────────────────────────────────────┐
  │                                                                  │
  │  Opening: ${APP_PASSWORD_URL.padEnd(50)} │
  │                                                                  │
  │  On the page:                                                    │
  │    1. Confirm app name is "SwiftMail" (auto-filled in URL)       │
  │       — if not, type "SwiftMail" in the input.                   │
  │    2. Click Create.                                              │
  │    3. Copy the 16-character code Google shows you                │
  │       (it has spaces — that's fine, paste as-is)                 │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
`);

  await tryOpenUrl(APP_PASSWORD_URL);
  await prompt('  Press Enter when the app password is generated and copied to clipboard…');

  // Step 4: Read password (hidden input)
  console.log('');
  let smtpPass = '';
  while (true) {
    smtpPass = await promptHidden('  Paste the 16-char app password (input hidden): ');
    smtpPass = smtpPass.replace(/\s+/g, ''); // strip spaces
    if (smtpPass.length === 16 && /^[a-zA-Z]+$/.test(smtpPass)) break;
    console.log(`  ✗ Expected 16 letters, got ${smtpPass.length} char(s). Try again.\n`);
  }

  // Step 5: REPORT_TO
  const defaultReportTo = env.REPORT_TO || smtpUser;
  const reportTo = (await prompt(`\n  Send daily reports to [${defaultReportTo}]: `)).trim() || defaultReportTo;

  // Step 6: Save .env
  const newEnv = {
    ...env,
    OLLAMA_URL: env.OLLAMA_URL || 'http://localhost:11434',
    OLLAMA_MODEL: env.OLLAMA_MODEL || 'llama3.3:70b',
    SMTP_USER: smtpUser,
    SMTP_PASS: smtpPass,
    SMTP_HOST: env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: env.SMTP_PORT || '465',
    REPORT_TO: reportTo,
  };
  writeEnv(newEnv);
  console.log(`\n  ✓ Saved to ${path.relative(process.cwd(), ENV_PATH)}`);

  // Step 7: Test send
  console.log('\n  Sending test email…');
  await testEmail(newEnv);

  console.log(`
  ┌─ Setup complete ─────────────────────────────────────────────────┐
  │                                                                  │
  │  Daily reports will email ${reportTo.padEnd(34)} │
  │                                                                  │
  │  Add to crontab on the server (run \`crontab -e\`):                │
  │    0 9 * * *  cd /srv/swiftmail-landing/content-pipeline && \\     │
  │                node daily-report.mjs >> logs/cron.log 2>&1       │
  │                                                                  │
  │  Test anytime:                                                   │
  │    pnpm setup:smtp --test                                        │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
`);
})().catch((err) => {
  console.error('\n✗', err.message);
  process.exit(1);
});

// ── Steps ────────────────────────────────────────────────────────────

async function testEmail(env) {
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 465),
    secure: Number(env.SMTP_PORT || 465) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  // Verify auth
  try {
    await transporter.verify();
  } catch (err) {
    die(
      `SMTP auth failed: ${err.message}\n  ` +
        `→ Most likely: app password is wrong, or 2FA isn't enabled, or the password was revoked.\n  ` +
        `→ Re-run setup-smtp.mjs and generate a fresh password.`
    );
  }

  // Send test
  const info = await transporter.sendMail({
    from: `"SwiftMail Pipeline" <${env.SMTP_USER}>`,
    to: env.REPORT_TO || env.SMTP_USER,
    subject: '✓ SwiftMail pipeline SMTP test',
    text: `If you're reading this, SMTP is configured correctly.\n\nDaily reports will arrive at this address each morning.\n\n— SwiftMail content pipeline`,
    html: `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 32px auto; padding: 0 24px; color: #0f172a;">
  <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
    <h1 style="margin: 0 0 12px; font-size: 22px;">✓ SMTP test successful</h1>
    <p style="color: #64748b; margin: 0 0 20px;">If you're reading this, SwiftMail's content pipeline can email you.</p>
    <p style="color: #475569; font-size: 14px;">Daily reports will arrive at this address each morning at 9 AM (server time) once you wire up the cron job.</p>
    <p style="color: #94a3b8; margin: 20px 0 0; font-size: 12px;">— SwiftMail content pipeline</p>
  </div>
</body></html>`,
  });

  console.log(`  ✓ Test email sent (messageId: ${info.messageId})`);
  console.log(`  ✓ Check inbox at: ${env.REPORT_TO || env.SMTP_USER}`);
}

// ── .env helpers ─────────────────────────────────────────────────────

function readEnv() {
  const sourcePath = fs.existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE_PATH;
  if (!fs.existsSync(sourcePath)) return {};
  const txt = fs.readFileSync(sourcePath, 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

function writeEnv(env) {
  const lines = [
    '# .env — content-pipeline configuration',
    '# Generated by setup-smtp.mjs. Edit by hand or re-run setup.',
    '',
    '# ── Ollama ──────────────────────────────────────────────',
    `OLLAMA_URL=${env.OLLAMA_URL || 'http://localhost:11434'}`,
    `OLLAMA_MODEL=${env.OLLAMA_MODEL || 'llama3.3:70b'}`,
    '',
    '# ── SMTP for daily-report.mjs ──────────────────────────',
    `SMTP_USER=${env.SMTP_USER || ''}`,
    `SMTP_PASS=${env.SMTP_PASS || ''}`,
    `SMTP_HOST=${env.SMTP_HOST || 'smtp.gmail.com'}`,
    `SMTP_PORT=${env.SMTP_PORT || '465'}`,
    `REPORT_TO=${env.REPORT_TO || env.SMTP_USER || ''}`,
    '',
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
  fs.chmodSync(ENV_PATH, 0o600); // owner-only — secrets inside
}

function printEnv(env) {
  console.log('  Resolved environment:\n');
  const masked = { ...env };
  if (masked.SMTP_PASS) {
    masked.SMTP_PASS =
      masked.SMTP_PASS.slice(0, 2) + '…'.repeat(12) + masked.SMTP_PASS.slice(-2);
  }
  for (const [k, v] of Object.entries(masked)) {
    console.log(`    ${k.padEnd(15)} ${v || '(unset)'}`);
  }
  console.log();
}

// ── UI helpers ───────────────────────────────────────────────────────

function banner() {
  console.log(`
  ╔══════════════════════════════════════════════════════════════════╗
  ║  SwiftMail Pipeline — SMTP setup                                 ║
  ╚══════════════════════════════════════════════════════════════════╝`);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt with hidden input (password-style).
 * Falls back to visible prompt if stdin isn't a TTY.
 */
function promptHidden(question) {
  if (!process.stdin.isTTY) return prompt(question); // e.g. piped input

  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let buffer = '';
    const onData = (chunk) => {
      // Backspace / delete
      if (chunk === '' || chunk === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      // Enter
      if (chunk === '\r' || chunk === '\n') {
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(buffer);
        return;
      }
      // Ctrl-C
      if (chunk === '') {
        process.stdout.write('^C\n');
        process.exit(130);
      }
      // Add to buffer (no echo)
      buffer += chunk;
    };
    process.stdin.on('data', onData);
  });
}

function tryOpenUrl(url) {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // No GUI available (e.g. SSH session) — that's fine, user can copy the URL
      resolve();
    });
    child.unref();
    setTimeout(resolve, 500);
  });
}

function die(msg) {
  console.error('\n✗', msg);
  process.exit(1);
}
