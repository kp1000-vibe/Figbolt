/**
 * Measure what actually breaks on a phone.
 *
 *   node scripts/mobile-audit.mjs [baseUrl] [outDir]
 *
 * Checks each route at iPhone width for the three failures that make a
 * responsive web app feel broken on mobile, and that no amount of squinting
 * at a desktop browser will reveal:
 *
 *   1. horizontal page scroll — the page is wider than the screen
 *   2. elements overflowing the viewport
 *   3. tap targets below the 44px Apple / 48px Android minimum
 *
 * Reports rather than fixes. Run it again after changes to see the delta.
 */
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = process.argv[3] ?? 'docs/mobile';

const EMAIL = 'alex@northwindlabs.com';
const PASSWORD = 'demo1234';

const ROUTES = [
  '/home',
  '/ask',
  '/inbox',
  '/accounts',
  '/contacts',
  '/opportunities',
  '/tasks',
  '/meetings',
  '/agents',
  '/automations',
  '/prospecting',
  '/analytics',
  '/product-signals',
  '/knowledge',
  '/learning',
  '/integrations',
  '/settings',
];

const TAP_MIN = 44;

async function audit(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);

  return page.evaluate((tapMin) => {
    const vw = document.documentElement.clientWidth;

    /*
     * Measuring this correctly turned out to matter more than measuring it at
     * all. Two earlier metrics were wrong:
     *
     *   documentElement.scrollWidth  counts content inside overflow-x:auto
     *     containers, so an intentional kanban board read as a broken page.
     *   "any control under 44px"     flags every inline link in a sentence,
     *     which is 1300 false positives and no signal.
     *
     * So: sideways scroll is tested by actually trying to scroll, and tap
     * targets exclude links that sit inline inside text.
     */
    const beforeX = window.scrollX;
    window.scrollTo(vw * 4, window.scrollY);
    const scrolledTo = window.scrollX;
    window.scrollTo(beforeX, window.scrollY);

    // Content past the right edge that no scroller can reach is simply lost.
    const clipped = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 2) continue;

      let inScroller = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === 'auto' || ov === 'scroll') { inScroller = true; break; }
      }
      if (inScroller || getComputedStyle(el).position === 'fixed') continue;

      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '').slice(0, 70),
        right: Math.round(r.right),
      });
    }

    /*
     * Tap targets. WCAG 2.5.8 sets 24px and exempts links inline in a
     * sentence; Apple and Android ask for 44/48 on standalone controls. So a
     * standalone control under 44px is a warning, and anything under 24px
     * that is not an inline link is a genuine failure.
     */
    const tight = [];
    const failing = [];
    for (const el of document.querySelectorAll('a, button, [role="button"], input, select')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const display = getComputedStyle(el).display;
      const inlineInText =
        el.tagName === 'A' &&
        (display === 'inline' || display === 'inline-block') &&
        el.parentElement !== null &&
        (el.parentElement.textContent || '').trim().length >
          (el.textContent || '').trim().length + 8;

      const entry = {
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 36),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      };

      if (!inlineInText && (r.height < 24 || r.width < 24)) failing.push(entry);
      else if (!inlineInText && (r.height < tapMin || r.width < tapMin)) tight.push(entry);
    }

    return {
      scrollsSideways: scrolledTo > beforeX,
      bodyWidth: document.body.scrollWidth,
      viewport: vw,
      clipped: clipped.slice(0, 6),
      clippedCount: clipped.length,
      failingTargets: failing.slice(0, 6),
      failingCount: failing.length,
      tightTargets: tight.slice(0, 4),
      tightCount: tight.length,
    };
  }, TAP_MIN);
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    // The seeded demo workspace, not a real account.
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]).catch(() => {});

  console.log(`\nAuditing ${ROUTES.length} routes at ${page.viewportSize()?.width}px\n`);

  const results = [];
  for (const route of ROUTES) {
    try {
      const r = await audit(page, route);
      results.push({ route, ...r });
      const flags = [
        r.scrollsSideways ? `SIDE-SCROLL` : '',
        r.clippedCount ? `${r.clippedCount} clipped` : '',
        r.failingCount ? `${r.failingCount} taps <24px` : '',
        r.tightCount ? `${r.tightCount} taps <44px` : '',
      ].filter(Boolean);
      console.log(`  ${flags.length ? '!' : '+'} ${route.padEnd(18)} ${flags.join(' · ') || 'clean'}`);
    } catch (err) {
      results.push({ route, error: String(err).slice(0, 120) });
      console.log(`  x ${route.padEnd(18)} ${String(err).slice(0, 70)}`);
    }
  }

  await browser.close();
  writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(results, null, 2));

  const sideways = results.filter((r) => r.scrollsSideways);
  const clipped = results.filter((r) => (r.clippedCount ?? 0) > 0);
  const failing = results.reduce((n, r) => n + (r.failingCount ?? 0), 0);
  const tight = results.reduce((n, r) => n + (r.tightCount ?? 0), 0);

  console.log(`\n  routes scrolling sideways   : ${sideways.length}/${results.length}`);
  console.log(`  routes with clipped content : ${clipped.length}/${results.length}`);
  console.log(`  tap targets under 24px      : ${failing}  (WCAG 2.5.8 failure)`);
  console.log(`  tap targets 24-${TAP_MIN}px        : ${tight}  (below platform guidance)`);
  console.log(`\n  -> ${path.join(OUT, 'audit.json')}\n`);

  for (const r of clipped.slice(0, 5)) {
    console.log(`  ${r.route} — ${r.clippedCount} element(s) past ${r.viewport}px:`);
    for (const o of r.clipped.slice(0, 3)) {
      console.log(`    <${o.tag} class="${o.cls}"> ends at ${o.right}px`);
    }
  }
}

main().catch((err) => {
  console.error('\nAudit failed:', err);
  process.exit(1);
});
