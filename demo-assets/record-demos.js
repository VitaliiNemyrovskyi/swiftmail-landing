/**
 * SwiftMail demo recording — Playwright driver
 *
 * Records 4 feature demos as WebM:
 *   1. feature-1-capture: rage-click in mock-store → signal in dashboard
 *   2. feature-2-ai-why: AI insight panel state machine
 *   3. feature-3-multichannel: flow builder fan-out
 *   4. feature-4-journey: attribution model toggling
 *
 * Output: demo-assets/recordings/feature-N.webm
 * Convert to MP4 separately via ffmpeg (see Makefile).
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const STORE = (page) => `file://${path.join(ROOT, 'mock-store', page)}`;
const DASH = (page) => `file://${path.join(ROOT, 'mock-dashboard', page)}`;
const REC_DIR = path.join(ROOT, 'recordings');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function recordDemo(browser, name, fn) {
  console.log(`\n▶ Recording ${name}...`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    recordVideo: { dir: REC_DIR, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await fn(page);
  await page.close();
  await context.close();
  // Find newly written .webm and rename
  const files = fs.readdirSync(REC_DIR)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({ name: f, time: fs.statSync(path.join(REC_DIR, f)).mtime }))
    .sort((a, b) => b.time - a.time);
  if (files[0]) {
    const target = path.join(REC_DIR, `${name}.webm`);
    fs.renameSync(path.join(REC_DIR, files[0].name), target);
    console.log(`  ✓ Saved ${name}.webm`);
  }
}

// ============================================================
// FEATURE 1 — Behavioral capture (rage click → dashboard signal)
// ============================================================
async function feature1(page) {
  // Open the store product page
  await page.goto(STORE('product.html'));
  await page.waitForLoadState('networkidle');
  await sleep(800);

  await page.evaluate(() => window.setCaption('A visitor lands on the product page'));
  await sleep(2400);

  await page.evaluate(() => window.setCaption('They try to apply a discount code…'));
  // Scroll to discount field
  await page.locator('#discount-input').scrollIntoViewIfNeeded();
  await sleep(800);
  await page.locator('#discount-input').click();
  await sleep(700);

  // Highlight the broken button
  await page.evaluate(() => window.setCaption('…and rage-click the submit button'));
  const btn = page.locator('#discount-btn');
  await btn.click();
  await sleep(180);
  await btn.click();
  await sleep(180);
  await btn.click();
  await sleep(1500);

  // Switch to dashboard sessions
  await page.evaluate(() => window.setCaption('SwiftMail captures the signal in real time'));
  await sleep(700);
  await page.goto(DASH('sessions.html'));
  await page.waitForLoadState('networkidle');
  await sleep(800);

  // Re-show caption (page changed)
  await page.evaluate(() => window.setCaption('SwiftMail captures the signal in real time'));
  await sleep(800);
  await page.evaluate(() => window.insertRageClickSession());
  await sleep(2200);

  await page.evaluate(() => window.setCaption('12 behavioral signals from one snippet — no extra setup'));
  await sleep(2800);
}

// ============================================================
// FEATURE 2 — AI explanation
// ============================================================
async function feature2(page) {
  await page.goto(DASH('insights.html'));
  await page.waitForLoadState('networkidle');
  await sleep(900);

  await page.evaluate(() => window.setCaption('A session ended without conversion'));
  await sleep(2600);

  await page.evaluate(() => window.setCaption("Click 'Explain' to understand why"));
  await sleep(1400);

  // Click Explain
  await page.locator('#ai-explain-btn').click();
  await page.evaluate(() => window.aiSetState('thinking'));
  await sleep(2800);

  // Show reason
  await page.evaluate(() => window.aiSetState('result'));
  await page.evaluate(() => window.setCaption('AI reads the full event timeline…'));
  await sleep(1500);

  // Type narrative
  await page.evaluate(() => window.setCaption('…and resolves to a structured reason'));
  await page.evaluate(() => window.aiTypeNarrative(
    "The visitor lingered on the product page, applied a discount code that silently failed, and rage-clicked the submit button before bouncing. This pattern matches PRICE_HESITATION — visitors looking for a deal who hit friction at the discount step.",
    16
  ));
  await sleep(800);

  await page.evaluate(() => window.setCaption('Plus a narrative + suggested next action'));
  await page.evaluate(() => window.aiShowActions());
  await sleep(3500);
}

// ============================================================
// FEATURE 3 — Multichannel triggers
// ============================================================
async function feature3(page) {
  await page.goto(DASH('flow.html'));
  await page.waitForLoadState('networkidle');
  await sleep(900);

  await page.evaluate(() => window.setCaption('A behavior signal hits the Flow Builder'));
  await sleep(2400);

  await page.evaluate(() => window.setCaption('One trigger, multiple channels'));
  await sleep(1200);

  // Trigger the simulation (button click triggers flowSimulate())
  await page.locator('#trigger-btn').click();
  await sleep(2000);

  await page.evaluate(() => window.setCaption('Email, SMS, web push, popup — all fire from one rule'));
  await sleep(2400);

  await page.evaluate(() => window.setCaption('No middleware. No glue code.'));
  await sleep(2800);
}

// ============================================================
// FEATURE 4 — Customer journey + attribution
// ============================================================
async function feature4(page) {
  await page.goto(DASH('journey.html'));
  await page.waitForLoadState('networkidle');
  await sleep(900);

  await page.evaluate(() => window.setCaption('Every session stitched into one customer journey'));
  await sleep(2800);

  await page.evaluate(() => window.setCaption('Toggle the attribution model'));
  await sleep(1600);

  // Cycle through attribution models
  await page.locator('[data-model="first"]').click();
  await page.evaluate(() => window.setCaption('First-touch shows who brought them in'));
  await sleep(2800);

  await page.locator('[data-model="last"]').click();
  await page.evaluate(() => window.setCaption('Last-touch shows who closed them'));
  await sleep(2400);

  await page.locator('[data-model="time"]').click();
  await page.evaluate(() => window.setCaption('Time-decay weights recent touches more'));
  await sleep(2400);

  await page.locator('[data-model="position"]').click();
  await page.evaluate(() => window.setCaption('Five models built in. Switch any time.'));
  await sleep(2800);
}

// ============================================================
// MAIN
// ============================================================
(async () => {
  if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  await recordDemo(browser, 'feature-1-capture', feature1);
  await recordDemo(browser, 'feature-2-ai-why', feature2);
  await recordDemo(browser, 'feature-3-multichannel', feature3);
  await recordDemo(browser, 'feature-4-journey', feature4);

  await browser.close();
  console.log('\n✓ All 4 demos recorded. Run convert.sh next.');
})();
