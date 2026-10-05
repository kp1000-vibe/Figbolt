import { getCurrentUser } from '@/lib/auth/session';
import { hashIp } from '@/lib/security/crypto';
import { SITE } from '@/lib/seo';
import { checkRateLimit } from '@/server/rate-limit';
import { countablePath, isBot, recordVisit, referrerHostOf } from '@/server/site-analytics';

/**
 * Page-view beacon for the public site. Always answers 204 — a visitor's page
 * must never see an error from analytics, and a forged request learns nothing.
 *
 * Not counted: bots, signed-in users (customers and you, not prospects),
 * anything that is not a public page, and bursts from one address.
 *
 * Deliberately not named "analytics" or "collect": content blockers drop
 * requests to paths like that, which would undercount real visitors.
 */
const NO_CONTENT = () => new Response(null, { status: 204 });

export async function POST(request: Request) {
  try {
    const userAgent = request.headers.get('user-agent');
    if (isBot(userAgent)) return NO_CONTENT();

    const body = (await request.json().catch(() => null)) as { path?: unknown; referrer?: unknown } | null;
    const path = countablePath(body?.path);
    if (!path) return NO_CONTENT();

    if (await getCurrentUser()) return NO_CONTENT();

    const ip =
      request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';

    const limit = await checkRateLimit(`pv:${hashIp(ip) ?? 'unknown'}`, 60, 60);
    if (!limit.allowed) return NO_CONTENT();

    await recordVisit({
      ip,
      userAgent: userAgent!,
      path,
      referrerHost: referrerHostOf(body?.referrer, new URL(SITE.url).hostname),
      country: request.headers.get('x-vercel-ip-country'),
    });
  } catch (err) {
    console.error('[site-analytics] could not record a visit:', (err as Error).message);
  }
  return NO_CONTENT();
}
