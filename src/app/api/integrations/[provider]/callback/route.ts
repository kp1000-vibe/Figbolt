import { NextResponse } from 'next/server';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@/db/schema';
import { env } from '@/lib/env';
import { UnauthenticatedError } from '@/lib/auth/session';
import { requireCtx, ValidationError } from '@/server/context';
import { connectIntegration } from '@/server/integrations/manage';
import { decodeState, exchangeCode, OAUTH_COOKIE } from '@/server/integrations/oauth';

/**
 * Step two: the provider sends the user back here with an authorization code.
 *
 * Four checks before the code is redeemed, and all four must pass:
 *
 *   1. there is a live session, and it belongs to the user named in the state
 *   2. the state's HMAC verifies and it has not expired
 *   3. the state's provider matches the route's provider
 *   4. the nonce in the state matches the one in the httpOnly cookie
 *
 * Check 4 is what stops a state value captured from one browser being redeemed
 * in another, and check 1 stops a code being bound to a different account than
 * the one that started the flow. The cookie is cleared either way, so a code
 * can only ever be presented once.
 *
 * Nothing about the tokens is written to the URL, the log or the audit
 * metadata — only the fact of a connection.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: raw } = await params;
  const url = new URL(request.url);

  // The provider reports user-facing refusals here rather than as an error.
  const denied = url.searchParams.get('error');
  if (denied) {
    return clear(back(denied === 'access_denied' ? 'Connection cancelled.' : `Provider error: ${denied}`));
  }

  if (!INTEGRATION_PROVIDERS.includes(raw as IntegrationProvider)) {
    return clear(back('Unknown integration.'));
  }
  const provider = raw as IntegrationProvider;

  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  if (!code || !stateRaw) return clear(back('The provider returned an incomplete response.'));

  const state = decodeState(stateRaw);
  if (!state) return clear(back('That connection link is invalid or has expired. Try again.'));
  if (state.p !== provider) return clear(back('That connection link is for a different service.'));

  let ctx: Awaited<ReturnType<typeof requireCtx>>;
  try {
    ctx = await requireCtx();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return clear(NextResponse.redirect(new URL('/login', env.APP_URL)));
    }
    throw err;
  }

  // The grant must land on the workspace and user that began it.
  if (ctx.workspaceId !== state.w || ctx.userId !== state.u) {
    return clear(back('That connection was started by a different account.'));
  }

  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${OAUTH_COOKIE}=`))
    ?.slice(OAUTH_COOKIE.length + 1);

  if (!cookie) return clear(back('The connection could not be verified in this browser. Try again.'));

  const [nonce, verifier] = cookie.split('.');
  if (!nonce || !verifier || nonce !== state.n) {
    return clear(back('The connection could not be verified in this browser. Try again.'));
  }

  try {
    const tokens = await exchangeCode(provider, code, verifier);
    await connectIntegration(ctx, provider, {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens.accountLabel ? { accountLabel: tokens.accountLabel } : {}),
    });

    const ok = new URL('/integrations', env.APP_URL);
    ok.searchParams.set('connected', provider);
    return clear(NextResponse.redirect(ok));
  } catch (err) {
    console.error(`[oauth] ${provider} callback failed:`, (err as Error).message);
    return clear(
      back(err instanceof ValidationError ? err.message : 'Could not complete the connection.'),
    );
  }
}

/**
 * Every exit from the handler above goes through here, so the single-use
 * verifier cookie is dropped whether the flow succeeded, failed or was
 * abandoned. A code that cannot be paired with a verifier cannot be replayed.
 */
function clear(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_COOKIE, '', {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/api/integrations',
    maxAge: 0,
  });
  return response;
}

function back(message: string) {
  const url = new URL('/integrations', env.APP_URL);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}
