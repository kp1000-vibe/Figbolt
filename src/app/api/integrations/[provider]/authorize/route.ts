import { NextResponse } from 'next/server';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@/db/schema';
import { env } from '@/lib/env';
import { UnauthenticatedError } from '@/lib/auth/session';
import { ctxAssert, requireCtx, ValidationError } from '@/server/context';
import { checkRateLimit } from '@/server/rate-limit';
import { record } from '@/server/audit';
import { buildAuthorizeUrl, oauthReady, OAUTH_COOKIE } from '@/server/integrations/oauth';

/**
 * Step one of connecting a mailbox or calendar: send the user to the
 * provider's consent screen.
 *
 * A GET that causes a redirect rather than a state change, so it is safe to
 * link to — but it still requires a session and `integration:manage`, because
 * the grant it initiates will be stored against this workspace.
 *
 * The PKCE verifier and the state nonce are written to one httpOnly,
 * SameSite=Lax cookie. Lax rather than Strict on purpose: the callback arrives
 * as a top-level cross-site navigation from the provider, and Strict would
 * withhold the cookie exactly when it is needed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: raw } = await params;

  let ctx: Awaited<ReturnType<typeof requireCtx>>;
  try {
    ctx = await requireCtx();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL('/login', env.APP_URL));
    }
    throw err;
  }

  try {
    ctxAssert(ctx, 'integration:manage');
  } catch {
    return fail('You do not have permission to connect integrations.');
  }

  if (!INTEGRATION_PROVIDERS.includes(raw as IntegrationProvider)) {
    return fail('Unknown integration.');
  }
  const provider = raw as IntegrationProvider;

  if (!oauthReady(provider)) {
    return fail(
      `${provider} is not configured for live connection. Set its OAuth credentials and INTEGRATION_MODE=live.`,
    );
  }

  const limit = await checkRateLimit(`oauth-start:${ctx.workspaceId}`, 20, 600);
  if (!limit.allowed) return fail('Too many connection attempts. Try again shortly.');

  let start: ReturnType<typeof buildAuthorizeUrl>;
  try {
    start = buildAuthorizeUrl(ctx, provider);
  } catch (err) {
    return fail(err instanceof ValidationError ? err.message : 'Could not start the connection.');
  }

  await record(ctx, {
    action: 'integration.oauth_started',
    resourceType: 'integration',
    resourceId: provider,
    riskLevel: 'medium',
    metadata: { provider },
  });

  const response = NextResponse.redirect(start.url);
  response.cookies.set(OAUTH_COOKIE, start.cookieValue, {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/api/integrations',
    maxAge: 600,
  });
  return response;
}

/** Send the user back to the page they came from, with a readable reason. */
function fail(message: string) {
  const url = new URL('/integrations', env.APP_URL);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}
