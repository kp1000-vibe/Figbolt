import { createHash, randomBytes } from 'node:crypto';
import { and, desc, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { siteSalts, siteVisits } from '@/db/schema';
import { PUBLIC_ROUTES } from '@/lib/seo';

/**
 * Website analytics for the public site — privacy-first.
 *
 * What is never stored: an IP address, a full user agent, a full referring
 * URL, or a cookie. What is stored: a visitor hash that is only stable within
 * one UTC day, because it is salted with a random value that is deleted once
 * the day is over. That makes "unique visitors per day" exact while making it
 * impossible to follow a person across days or link a row back to them.
 */

/** Crawlers, link previewers and monitoring, which would inflate the count. */
const BOT_UA =
  /bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|monitor|uptime|curl|wget|python|node-fetch|axios|go-http|java\/|facebookexternalhit|embedly|whatsapp|vercel-screenshot|playwright|puppeteer/i;

export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_UA.test(userAgent);
}

export function deviceOf(userAgent: string): 'mobile' | 'tablet' | 'desktop' {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(userAgent)) return 'tablet';
  if (/mobi|iphone|android/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Only real public pages are counted, so a forged beacon cannot invent paths. */
export function countablePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  return (PUBLIC_ROUTES as readonly string[]).includes(clean) ? clean : null;
}

/** Hostname only, and not our own site — internal navigation is not a referral. */
export function referrerHostOf(referrer: unknown, ownHost: string): string | null {
  if (typeof referrer !== 'string' || !referrer) return null;
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    return host && host !== ownHost.replace(/^www\./, '') ? host.slice(0, 120) : null;
  } catch {
    return null;
  }
}

export function visitorHash(salt: string, ip: string, userAgent: string): string {
  return createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 32);
}

/** Today's salt, creating it if needed; yesterday's and older are deleted. */
async function saltFor(day: string): Promise<string> {
  const db = await getDb();
  await db
    .insert(siteSalts)
    .values({ day, salt: randomBytes(32).toString('hex') })
    .onConflictDoNothing();
  // Once a day is over its salt goes, and with it any way to re-derive a hash.
  await db.delete(siteSalts).where(lt(siteSalts.day, day));
  const rows = await db.select().from(siteSalts).where(sql`${siteSalts.day} = ${day}`);
  return rows[0]!.salt;
}

export async function recordVisit(input: {
  ip: string;
  userAgent: string;
  path: string;
  referrerHost: string | null;
  country: string | null;
}): Promise<void> {
  const day = utcDay();
  const salt = await saltFor(day);
  const db = await getDb();
  await db.insert(siteVisits).values({
    day,
    visitorHash: visitorHash(salt, input.ip, input.userAgent),
    path: input.path,
    referrerHost: input.referrerHost,
    country: input.country && /^[A-Z]{2}$/.test(input.country) ? input.country : null,
    device: deviceOf(input.userAgent),
  });
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export type SiteStats = {
  days: number;
  /** One entry per day in the window, oldest first, zero-filled. */
  daily: { day: string; visitors: number; views: number }[];
  today: { visitors: number; views: number };
  /** Sum of daily unique visitors: a repeat visitor counts once per day. */
  visitorDays: number;
  views: number;
  topPages: { label: string; count: number }[];
  topReferrers: { label: string; count: number }[];
  countries: { label: string; count: number }[];
  devices: { label: string; count: number }[];
};

export async function getSiteStats(days = 30): Promise<SiteStats> {
  const db = await getDb();
  const since = utcDay(new Date(Date.now() - (days - 1) * 86_400_000));
  const window = gte(siteVisits.day, since);

  const dailyRows = await db
    .select({
      day: siteVisits.day,
      visitors: sql<number>`count(distinct ${siteVisits.visitorHash})::int`,
      views: sql<number>`count(*)::int`,
    })
    .from(siteVisits)
    .where(window)
    .groupBy(siteVisits.day);

  const byDay = new Map(dailyRows.map((r) => [r.day, r]));
  const daily: SiteStats['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(new Date(Date.now() - i * 86_400_000));
    const row = byDay.get(day);
    daily.push({ day, visitors: Number(row?.visitors ?? 0), views: Number(row?.views ?? 0) });
  }

  // Each breakdown counts visitor-days, not raw views, so one person
  // refreshing a page cannot dominate it.
  const breakdown = async (column: typeof siteVisits.path | typeof siteVisits.referrerHost | typeof siteVisits.country | typeof siteVisits.device) => {
    const rows = await db
      .select({
        label: column,
        count: sql<number>`count(distinct (${siteVisits.day} || ${siteVisits.visitorHash}))::int`,
      })
      .from(siteVisits)
      .where(and(window, sql`${column} is not null`))
      .groupBy(column)
      .orderBy(desc(sql`2`))
      .limit(8);
    return rows.map((r) => ({ label: String(r.label), count: Number(r.count) }));
  };

  const [topPages, topReferrers, countries, devices] = await Promise.all([
    breakdown(siteVisits.path),
    breakdown(siteVisits.referrerHost),
    breakdown(siteVisits.country),
    breakdown(siteVisits.device),
  ]);

  const today = daily[daily.length - 1]!;
  return {
    days,
    daily,
    today: { visitors: today.visitors, views: today.views },
    visitorDays: daily.reduce((n, d) => n + d.visitors, 0),
    views: daily.reduce((n, d) => n + d.views, 0),
    topPages,
    topReferrers,
    countries,
    devices,
  };
}
