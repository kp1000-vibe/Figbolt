import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHarness, type Harness } from './harness';
import { safeNext } from '@/lib/auth/safe-next';
import {
  countablePath,
  deviceOf,
  getSiteStats,
  isBot,
  recordVisit,
  referrerHostOf,
  utcDay,
  visitorHash,
} from '@/server/site-analytics';

/**
 * Website analytics, and the promise it makes: unique visitors are counted
 * without storing anything that identifies a person.
 */

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

describe('counting a visitor without identifying them', () => {
  it('gives the same visitor the same hash within a day, and a new one when the salt changes', () => {
    const a = visitorHash('salt-day-1', '203.0.113.7', CHROME);
    expect(visitorHash('salt-day-1', '203.0.113.7', CHROME)).toBe(a);
    expect(visitorHash('salt-day-2', '203.0.113.7', CHROME)).not.toBe(a);
    expect(visitorHash('salt-day-1', '203.0.113.8', CHROME)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain('203');
  });

  it('ignores crawlers, previewers and scripts', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'facebookexternalhit/1.1',
      'curl/8.4.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/141.0',
      '',
    ]) {
      expect(isBot(ua), ua).toBe(true);
    }
    expect(isBot(null)).toBe(true);
    expect(isBot(CHROME)).toBe(false);
    expect(isBot(IPHONE)).toBe(false);
  });

  it('counts only real public pages', () => {
    expect(countablePath('/')).toBe('/');
    expect(countablePath('/ai-crm?utm_source=linkedin')).toBe('/ai-crm');
    expect(countablePath('/crm-for-solopreneurs/')).toBe('/crm-for-solopreneurs');
    // App routes are customers' data; forged paths are noise.
    expect(countablePath('/accounts')).toBeNull();
    expect(countablePath('/home')).toBeNull();
    expect(countablePath('/made-up-page')).toBeNull();
    expect(countablePath(42)).toBeNull();
  });

  it('keeps only the referring site, never the full URL', () => {
    expect(referrerHostOf('https://www.google.com/search?q=ai+crm', 'figbolt.com')).toBe('google.com');
    expect(referrerHostOf('https://www.linkedin.com/feed/update/urn:li:activity:123', 'figbolt.com')).toBe('linkedin.com');
    expect(referrerHostOf('https://figbolt.com/why', 'figbolt.com')).toBeNull();
    expect(referrerHostOf('not a url', 'figbolt.com')).toBeNull();
    expect(referrerHostOf(null, 'figbolt.com')).toBeNull();
  });

  it('sorts devices coarsely', () => {
    expect(deviceOf(CHROME)).toBe('desktop');
    expect(deviceOf(IPHONE)).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X)')).toBe('tablet');
  });
});

describe('stored visits', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });

  it('counts unique visitors per day, and stores no IP address anywhere', async () => {
    const visit = (ip: string, ua: string, path: string) =>
      recordVisit({ ip, userAgent: ua, path, referrerHost: 'google.com', country: 'IN' });

    await visit('198.51.100.1', CHROME, '/');
    await visit('198.51.100.1', CHROME, '/ai-crm'); // same person, second page
    await visit('198.51.100.2', IPHONE, '/');

    const stats = await getSiteStats(7);
    expect(stats.today.visitors).toBe(2);
    expect(stats.today.views).toBe(3);
    expect(stats.daily).toHaveLength(7);
    expect(stats.topPages[0]).toEqual({ label: '/', count: 2 });
    expect(stats.countries).toEqual([{ label: 'IN', count: 2 }]);

    // The point of the design: nothing in the table can name a visitor.
    const rows = await h.db.execute(sql`select * from site_visits`);
    const dump = JSON.stringify((rows as unknown as { rows: unknown[] }).rows);
    expect(dump).not.toContain('198.51.100');
    expect(dump).not.toContain('Chrome');
  });

  it('deletes old salts, so past days cannot be re-identified', async () => {
    await h.db.execute(sql`insert into site_salts (day, salt) values ('2020-01-01', 'old')`);
    await recordVisit({ ip: '198.51.100.9', userAgent: CHROME, path: '/', referrerHost: null, country: null });
    const salts = await h.db.execute(sql`select day from site_salts`);
    const days = (salts as unknown as { rows: { day: string }[] }).rows.map((r) => r.day);
    expect(days).toEqual([utcDay()]);
  });

  it('rejects a forged country value', async () => {
    await recordVisit({ ip: '198.51.100.10', userAgent: CHROME, path: '/why', referrerHost: null, country: '<script>' });
    const rows = await h.db.execute(sql`select country from site_visits where path = '/why'`);
    expect((rows as unknown as { rows: { country: string | null }[] }).rows[0]!.country).toBeNull();
  });
});

describe('who may see the analytics', () => {
  afterEach(() => {
    delete process.env['SITE_ADMIN_EMAILS'];
    vi.resetModules();
  });

  async function admin(emails: string | undefined, who: string) {
    if (emails === undefined) delete process.env['SITE_ADMIN_EMAILS'];
    else process.env['SITE_ADMIN_EMAILS'] = emails;
    vi.resetModules();
    const { isSiteAdmin } = await import('@/lib/site-admin');
    return isSiteAdmin(who);
  }

  it('is nobody when unset', async () => {
    expect(await admin(undefined, 'owner@figbolt.com')).toBe(false);
  });

  it('is exactly the listed emails, case-insensitively', async () => {
    expect(await admin('Owner@Figbolt.com, partner@figbolt.com', 'owner@figbolt.com')).toBe(true);
    expect(await admin('owner@figbolt.com', 'partner@figbolt.com')).toBe(false);
    expect(await admin('owner@figbolt.com', 'owner@figbolt.com.evil.example')).toBe(false);
  });
});

describe('sign-in redirect', () => {
  it('only ever returns to a path on this site', () => {
    expect(safeNext('/admin/site-analytics')).toBe('/admin/site-analytics');
    expect(safeNext('/accounts?tab=open')).toBe('/accounts?tab=open');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\tjavascript:alert(1)',
      'javascript:alert(1)',
      '',
      undefined,
      null,
    ]) {
      expect(safeNext(bad as string | undefined), String(bad)).toBe('/home');
    }
  });
});
