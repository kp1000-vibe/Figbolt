/**
 * A signed-in browser context for the seeded demo workspace, reused across runs.
 *
 * Signing in on every run trips the login rate limit (8 attempts per address
 * per 15 minutes) after a handful of audits — the limiter doing its job. So the
 * session is saved once to the OS temp directory, outside the repo, and reused
 * until the server stops honouring it.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The seeded demo user — fictional, and only present in a seeded database.
const EMAIL = 'alex@northwindlabs.com';
const PASSWORD = 'demo1234';

function statePath(base) {
  const port = new URL(base).port || 'default';
  return path.join(os.tmpdir(), `figbolt-demo-session-${port}.json`);
}

async function stillSignedIn(context, base) {
  const page = await context.newPage();
  try {
    await page.goto(`${base}/home`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    return !new URL(page.url()).pathname.startsWith('/login');
  } finally {
    await page.close();
  }
}

/** Returns a context that is signed in, or throws with the reason it is not. */
export async function signedInContext(browser, base, contextOptions) {
  const file = statePath(base);

  if (existsSync(file)) {
    const context = await browser.newContext({ ...contextOptions, storageState: file });
    if (await stillSignedIn(context, base)) return context;
    await context.close();
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90_000 }).catch(() => {});

  if (new URL(page.url()).pathname.startsWith('/login')) {
    const alert = (await page.locator('[role=alert]').allTextContents()).join(' ').trim();
    await context.close();
    throw new Error(`sign-in did not complete${alert ? `: ${alert}` : ''}`);
  }

  await context.storageState({ path: file });
  await page.close();
  return context;
}
