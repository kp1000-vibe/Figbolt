/**
 * Capture the app at phone size, for a preview of what the mobile app shows.
 *
 *   node scripts/mobile-screens.mjs [baseUrl] [outDir]
 *
 * The Capacitor shell renders this same UI, so these are an honest preview of
 * the native app's content — minus the native chrome (status bar, push,
 * biometric unlock) which the shell adds around it.
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3400';
const OUT = process.argv[3] ?? 'docs/mobile/screens';

const SCREENS = [
  ['01-home', '/home', 'Home'],
  ['02-ask-bolt', '/ask', 'Ask Bolt'],
  ['03-inbox', '/inbox', 'Inbox'],
  ['04-accounts', '/accounts', 'Accounts'],
  ['05-opportunities', '/opportunities', 'Pipeline'],
  ['06-meetings', '/meetings', 'Meetings'],
  ['07-tasks', '/tasks', 'Tasks'],
  ['08-agents', '/agents', 'Agents & approvals'],
  ['09-integrations', '/integrations', 'Integrations'],
  ['10-analytics', '/analytics', 'Analytics'],
];

async function main() {
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 3 });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '00-login.png') });

  await page.fill('input[type="email"], input[name="email"]', 'alex@northwindlabs.com');
  await page.fill('input[type="password"], input[name="password"]', 'demo1234');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]).catch(() => {});

  console.log(`\nCapturing ${SCREENS.length} screens at 390x844\n`);
  for (const [file, route, label] of SCREENS) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(OUT, `${file}.png`) });
      console.log(`  + ${label}`);
    } catch (err) {
      console.log(`  x ${label}: ${String(err).slice(0, 70)}`);
    }
  }

  // The command bar, which is how you reach anything quickly on a phone.
  try {
    await page.goto(`${BASE}/accounts`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.locator('button[aria-label="Ask Bolt"]').click();
    await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.type('log call with Acme');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, '11-command-bar.png') });
    console.log('  + Command bar');
  } catch (err) {
    console.log(`  x Command bar: ${String(err).slice(0, 70)}`);
  }

  await browser.close();
  console.log(`\n  -> ${OUT}\n`);
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
