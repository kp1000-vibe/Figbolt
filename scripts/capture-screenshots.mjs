/**
 * Capture screenshots of every significant surface, for the feature document.
 *
 *   node scripts/capture-screenshots.mjs [baseUrl] [outDir]
 *
 * Signs in as the seeded demo owner, walks the app, and writes one PNG per
 * page. Deliberately a script rather than a test: these are documentation
 * artefacts, and a failed capture should not fail CI.
 *
 * Each page is given a settle window and the launcher is waited for
 * explicitly, because screenshotting mid-render produces a document full of
 * empty skeletons that looks like the product is broken.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3200';
const OUT = process.argv[3] ?? 'docs/screenshots';

const EMAIL = 'alex@northwindlabs.com';
const PASSWORD = 'demo1234';

/** label, path, and an optional selector to wait for before shooting. */
const PAGES = [
  ['01-landing', '/', { anon: true, full: true }],
  ['02-login', '/login', { anon: true }],
  ['18-why-figbolt', '/why', { anon: true, full: true }],
  ['03-home', '/home', {}],
  ['04-ask-bolt', '/ask', {}],
  ['05-inbox', '/inbox', {}],
  ['06-accounts', '/accounts', {}],
  ['07-contacts', '/contacts', {}],
  ['08-deals', '/opportunities', {}],
  ['09-tasks', '/tasks', {}],
  ['10-meetings', '/meetings', {}],
  ['11-agents', '/agents', {}],
  ['12-automations', '/automations', {}],
  ['13-prospecting', '/prospecting', {}],
  ['14-analytics', '/analytics', {}],
  ['15-product-signals', '/product-signals', {}],
  ['16-knowledge', '/knowledge', {}],
  ['17-learning', '/learning', { full: true }],
  ['19-integrations', '/integrations', {}],
  ['20-settings', '/settings', {}],
];

const results = [];

async function shoot(page, label, urlPath, opts) {
  const url = `${BASE}${urlPath}`;
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Dev-mode compiles on first hit; give the page time to finish painting.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(900);

    const file = path.join(OUT, `${label}.png`);
    await page.screenshot({ path: file, fullPage: Boolean(opts.full) });

    const title = await page.title();
    const landed = new URL(page.url()).pathname;
    const redirected = landed !== urlPath;

    results.push({
      label,
      path: urlPath,
      landed,
      redirected,
      status: res?.status() ?? null,
      title,
      file: `${label}.png`,
      ok: !redirected,
    });
    console.log(
      `  ${redirected ? '!' : '+'} ${label.padEnd(20)} ${urlPath.padEnd(18)} -> ${landed}`,
    );
  } catch (err) {
    results.push({ label, path: urlPath, ok: false, error: String(err).slice(0, 200) });
    console.log(`  x ${label.padEnd(20)} ${urlPath.padEnd(18)} FAILED: ${String(err).slice(0, 90)}`);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // legible in a document
    colorScheme: 'light',
  });
  const page = await context.newPage();

  console.log(`\nCapturing from ${BASE}\n`);

  // Anonymous pages first, before a session cookie exists.
  for (const [label, urlPath, opts] of PAGES.filter(([, , o]) => o.anon)) {
    await shoot(page, label, urlPath, opts);
  }

  // Sign in.
  console.log('\n  signing in as the demo owner…');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]).catch(() => {});
  console.log(`  landed on ${new URL(page.url()).pathname}\n`);

  for (const [label, urlPath, opts] of PAGES.filter(([, , o]) => !o.anon)) {
    await shoot(page, label, urlPath, opts);
  }

  // ── Interactive surfaces ────────────────────────────────────────────────
  // These three are the interaction, not the page, so a static shot proves
  // nothing. Each one clicks and then *waits for the thing it opened*, and
  // records a failure if it never appears. The first pass of this script shot
  // blind after a fixed delay and produced three screenshots of closed
  // dialogs that were reported as successes.

  /** Dev-mode hydration is slow; a click before it lands does nothing. */
  async function settle(p) {
    await p.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await p.waitForTimeout(2500);
  }

  async function interaction(label, file, description, run) {
    try {
      await run();
      await page.screenshot({ path: path.join(OUT, file) });
      results.push({ label, path: description, ok: true, file, title: description });
      console.log(`  + ${label.padEnd(20)} ${description}`);
    } catch (err) {
      results.push({ label, path: description, ok: false, error: String(err).slice(0, 200) });
      console.log(`  x ${label.padEnd(20)} FAILED: ${String(err).slice(0, 100)}`);
    }
  }

  await interaction('21-bolt-launcher', '21-bolt-launcher.png', 'Ask Bolt launcher (hovered)', async () => {
    await page.goto(`${BASE}/accounts`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const launcher = page.locator('button[aria-label="Ask Bolt"]');
    await launcher.waitFor({ state: 'visible', timeout: 20_000 });
    await launcher.hover();
    // The label expands on hover; wait for it rather than guessing a duration.
    await page.getByText('Ask Bolt', { exact: true }).first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  });

  await interaction('22-command-bar', '22-command-bar.png', 'Command bar, opened from the launcher', async () => {
    await page.locator('button[aria-label="Ask Bolt"]').click();
    // Proof the launcher actually opened something.
    await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.keyboard.type('log call with Acme, they confirmed budget');
    await page.waitForTimeout(800);
  });

  await interaction('23-schedule-meeting', '23-schedule-meeting.png', 'Schedule a meeting', async () => {
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/meetings`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByRole('button', { name: /schedule meeting/i }).click();
    // The modal is role=dialog with the title as its aria-label.
    await page.locator('[role="dialog"][aria-label="Schedule a meeting"]')
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(600);
  });

  await interaction('24-meeting-detail', '24-meeting-detail.png', 'Meeting detail: transcript and CRM actions', async () => {
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/meetings`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const first = page.locator('a[href^="/meetings/mtg_"]').first();
    await first.waitFor({ timeout: 20_000 });
    await first.click();
    await page.waitForURL(/\/meetings\/mtg_/, { timeout: 20_000 });
    await settle(page);
    await page.screenshot({ path: path.join(OUT, '24-meeting-detail.png'), fullPage: true });
  });

  // Dark mode, once, so the document can show the theme is a real peer.
  try {
    const dark = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      storageState: await context.storageState(),
    });
    const dp = await dark.newPage();
    await dp.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' });
    await dp.waitForTimeout(1600);
    await dp.screenshot({ path: path.join(OUT, '25-dark-mode.png') });
    results.push({ label: '25-dark-mode', path: '/home (dark)', ok: true, file: '25-dark-mode.png', title: 'Dark mode' });
    console.log('  + 25-dark-mode         home in dark theme');
    await dark.close();
  } catch (err) {
    console.log(`  x dark mode failed: ${String(err).slice(0, 120)}`);
  }

  await browser.close();

  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(results, null, 2));

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} captured -> ${OUT}\n`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('Not captured cleanly:');
    for (const f of failed) console.log(`  ${f.label}: ${f.error ?? `redirected to ${f.landed}`}`);
  }
}

main().catch((err) => {
  console.error('\nCapture failed:', err);
  process.exit(1);
});
