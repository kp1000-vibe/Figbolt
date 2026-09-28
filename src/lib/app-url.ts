import { env } from '@/lib/env';

/**
 * The origin this deployment is actually reachable at.
 *
 * `APP_URL` defaults to `http://localhost:3000` so a fresh clone runs without
 * configuration, which is right for development and dangerous everywhere else:
 * a production deployment that never sets it would emit localhost canonical
 * tags, localhost redirects, and — worst — a localhost OAuth redirect URI that
 * can never match what is registered with Google or Microsoft.
 *
 * So localhost is treated as "unset" rather than as an answer. One helper,
 * used by the SEO layer, the OAuth routes and anything else that needs an
 * absolute URL, so the deployment has a single idea of where it lives.
 */

const FALLBACK = 'https://figbolt.com';

function isLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(url);
}

let warned = false;

export function appOrigin(): string {
  const configured = env.APP_URL?.replace(/\/$/, '');

  if (configured && !isLoopback(configured)) return configured;

  // In development, localhost is the correct answer.
  if (env.NODE_ENV !== 'production') return configured || 'http://localhost:3000';

  if (!warned) {
    warned = true;
    console.warn(
      `[app-url] APP_URL is ${configured ? `"${configured}"` : 'unset'} in production; ` +
        `falling back to ${FALLBACK}. Set APP_URL so redirects and OAuth callbacks are correct.`,
    );
  }
  return FALLBACK;
}

/** An absolute URL on this deployment's own origin. */
export function appUrl(path = '/'): string {
  return `${appOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The origin to publish to the outside world.
 *
 * Distinct from `appOrigin()` on purpose, and the distinction is not cosmetic:
 * a loopback OAuth redirect URI is *correct* in development, because that is
 * what you register in a development OAuth app. A loopback canonical tag or
 * sitemap entry is never correct in any environment - it is published for
 * crawlers and other people, who cannot reach your machine.
 *
 * So this one never returns localhost, whatever NODE_ENV says.
 */
export function publicOrigin(): string {
  const configured = env.APP_URL?.replace(/\/$/, '');
  return configured && !isLoopback(configured) ? configured : FALLBACK;
}
