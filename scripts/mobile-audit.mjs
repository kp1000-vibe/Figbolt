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
 *   3. a widened layout viewport — fixed UI pushed off the screen
 *   4. controls drawn on top of each other — inside the viewport, so 1-3
 *      cannot see it, but a tap lands on the wrong one
 *   5. tap targets below the 44px Apple / 48px Android minimum
 *
 * Reports rather than fixes. Run it again after changes to see the delta.
 */
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { signedInContext } from './lib/demo-session.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = process.argv[3] ?? 'docs/mobile';

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

  // A redirect to /login would quietly audit the sign-in page instead of the
  // route — which is exactly how one run reported 17 clean routes.
  const landed = new URL(page.url()).pathname;
  if (landed !== route) throw new Error(`landed on ${landed}, not ${route}`);

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
    /*
     * A widened layout viewport is the failure the scroll test cannot see.
     * Mobile browsers size the layout viewport to the content, so anything
     * that escapes its scroller (an absolutely positioned sr-only label whose
     * containing block is <body>, say) makes innerWidth exceed the screen.
     * The page still does not scroll, but every position:fixed element is
     * laid out against the wider box — the Ask Bolt button was at x=941 on a
     * 390px phone.
     */
    const layoutWidth = window.innerWidth;
    const fixedOffscreen = [];
    for (const el of document.querySelectorAll('body *')) {
      if (getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.right > vw + 2) {
        fixedOffscreen.push({
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 36),
          right: Math.round(r.right),
        });
      }
    }

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
        cls: (el.getAttribute('class') || '').slice(0, 90),
      };

      if (!inlineInText && (r.height < 24 || r.width < 24)) failing.push(entry);
      else if (!inlineInText && (r.height < tapMin || r.width < tapMin)) tight.push(entry);
    }

    /*
     * Overlapping controls. Two interactive elements whose boxes intersect by
     * more than a sliver, where neither contains the other. Fixed elements are
     * skipped: a floating button is meant to sit over content.
     */
    const controls = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        for (let n = el; n; n = n.parentElement) {
          if (getComputedStyle(n).position === 'fixed') return false;
        }
        return getComputedStyle(el).visibility !== 'hidden';
      })
      .map((el) => ({ el, r: el.getBoundingClientRect() }));
    const overlaps = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // An inset control: a button drawn wholly inside a text field (the Ask
        // box's submit) is a deliberate pattern, provided the field reserves
        // padding for it — so only flag it when the padding is too small.
        const field = ['INPUT', 'TEXTAREA'].includes(a.el.tagName) ? a : ['INPUT', 'TEXTAREA'].includes(b.el.tagName) ? b : null;
        const inner = field === a ? b : a;
        if (
          field &&
          inner.r.left >= field.r.left && inner.r.right <= field.r.right &&
          inner.r.top >= field.r.top && inner.r.bottom <= field.r.bottom &&
          parseFloat(getComputedStyle(field.el).paddingRight) >= field.r.right - inner.r.left
        ) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 4 && h > 4) {
          const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || el.tagName).trim().slice(0, 28);
          overlaps.push(`${name(a.el)} x ${name(b.el)} (${Math.round(w)}x${Math.round(h)})`);
        }
      }
    }

    return {
      overlaps: overlaps.slice(0, 6),
      overlapCount: overlaps.length,
      scrollsSideways: scrolledTo > beforeX,
      layoutWidth,
      layoutWide: layoutWidth > vw + 2,
      fixedOffscreen,
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
  // Signed in once and reused: per-run sign-ins trip the login rate limit.
  const context = await signedInContext(browser, BASE, devices['iPhone 13']);
  const page = await context.newPage();

  console.log(`\nAuditing ${ROUTES.length} routes at ${page.viewportSize()?.width}px\n`);

  const results = [];
  for (const route of ROUTES) {
    try {
      const r = await audit(page, route);
      results.push({ route, ...r });
      const flags = [
        r.scrollsSideways ? `SIDE-SCROLL` : '',
        r.layoutWide ? `LAYOUT ${r.layoutWidth}px` : '',
        r.fixedOffscreen?.length ? `${r.fixedOffscreen.length} fixed off-screen` : '',
        r.overlapCount ? `${r.overlapCount} overlapping` : '',
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
  const wide = results.filter((r) => r.layoutWide);
  const overlapping = results.filter((r) => (r.overlapCount ?? 0) > 0);
  const clipped = results.filter((r) => (r.clippedCount ?? 0) > 0);
  const failing = results.reduce((n, r) => n + (r.failingCount ?? 0), 0);
  const tight = results.reduce((n, r) => n + (r.tightCount ?? 0), 0);

  console.log(`\n  routes scrolling sideways   : ${sideways.length}/${results.length}`);
  console.log(`  routes with wide layout     : ${wide.length}/${results.length}`);
  console.log(`  routes with clipped content : ${clipped.length}/${results.length}`);
  console.log(`  routes with overlapping UI  : ${overlapping.length}/${results.length}`);
  console.log(`  tap targets under 24px      : ${failing}  (WCAG 2.5.8 failure)`);
  console.log(`  tap targets 24-${TAP_MIN}px        : ${tight}  (below platform guidance)`);
  console.log(`\n  -> ${path.join(OUT, 'audit.json')}\n`);

  // Layout problems are the ones that break a route; make them fail CI-style.
  const errored = results.filter((r) => r.error).length;
  const broken = sideways.length + wide.length + clipped.length + overlapping.length + errored;
  process.exitCode = broken ? 1 : 0;

  for (const r of overlapping) {
    console.log(`  ${r.route} — overlapping controls:`);
    for (const o of r.overlaps.slice(0, 4)) console.log(`    ${o}`);
  }

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
