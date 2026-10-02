import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { integrations, type IntegrationProvider } from '@/db/schema';
import { env } from '@/lib/env';
import { appOrigin } from '@/lib/app-url';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';
import { scope, ValidationError, type Ctx } from '../context';
import { findProvider } from './providers';

/**
 * OAuth 2.0 authorization-code flow for the per-user connectors.
 *
 * This is the piece that lets Figbolt write to a rep's own calendar. Everything
 * else was already in place — the adapters, the encrypted token column, the
 * scheduling path — but there was no way to obtain a token, so
 * `connectIntegration` threw a message referring to "the OAuth flow" that did
 * not exist.
 *
 * Design decisions worth stating, because each one is a security property:
 *
 * **The token belongs to the user, not the workspace.** An event has to appear
 * on the organiser's calendar, and scoping the grant to one mailbox keeps the
 * blast radius of a leaked token to that person rather than the whole company.
 *
 * **State is signed, not stored.** The `state` parameter carries the workspace,
 * user, provider and an expiry, HMAC'd with AUTH_SECRET. A forged or replayed
 * callback fails signature or expiry checks. A nonce is *also* set in an
 * httpOnly cookie and compared on return, so a valid state stolen from one
 * browser cannot be redeemed in another.
 *
 * **PKCE on every flow.** We hold a client secret, so PKCE is not strictly
 * required, but it costs nothing and removes authorization-code interception
 * as a class of attack.
 *
 * **Refresh happens server-side, before use.** Google access tokens last about
 * an hour; a meeting scheduled in the afternoon would fail against a token
 * minted that morning. `freshAccessToken` refreshes on demand and re-encrypts.
 *
 * Tokens are never logged, never returned to the browser, and never leave the
 * server. The audit trail records that a connection happened, not its contents.
 */

/* ── Provider specs ───────────────────────────────────────────────────────── */

type OAuthSpec = {
  authorizeUrl: string;
  tokenUrl: string;
  /** Extra query params the provider needs on the authorize request. */
  authorizeParams?: Record<string, string>;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  /** Reads the connected account's own identifier, for the UI label. */
  identify?: (accessToken: string) => Promise<string | null>;
};

const GOOGLE: OAuthSpec = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  authorizeParams: {
    // `offline` is what yields a refresh token at all; `consent` forces it to
    // be re-issued, because Google only sends one on the *first* grant and a
    // reconnect would otherwise leave us unable to refresh.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
  clientId: () => env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: () => env.GOOGLE_OAUTH_CLIENT_SECRET,
  async identify(accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string };
    return json.email ?? null;
  },
};

const MICROSOFT: OAuthSpec = {
  get authorizeUrl() {
    return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/authorize`;
  },
  get tokenUrl() {
    return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/token`;
  },
  clientId: () => env.MICROSOFT_OAUTH_CLIENT_ID,
  clientSecret: () => env.MICROSOFT_OAUTH_CLIENT_SECRET,
  async identify(accessToken) {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { mail?: string; userPrincipalName?: string };
    return json.mail ?? json.userPrincipalName ?? null;
  },
};

/** Which providers this flow supports. Anything absent stays demo-only. */
const OAUTH: Partial<Record<IntegrationProvider, OAuthSpec>> = {
  gmail: GOOGLE,
  google_calendar: GOOGLE,
  google_drive: GOOGLE,
  outlook_mail: MICROSOFT,
  outlook_calendar: MICROSOFT,
  onedrive: MICROSOFT,
  ms_teams: MICROSOFT,
};

export function supportsOAuth(provider: IntegrationProvider): boolean {
  const spec = OAUTH[provider];
  if (!spec) return false;
  return Boolean(spec.clientId() && spec.clientSecret());
}

/** True when this provider can actually be connected for real right now. */
export function oauthReady(provider: IntegrationProvider): boolean {
  return env.INTEGRATION_MODE === 'live' && supportsOAuth(provider);
}

/* ── Redirect URI ─────────────────────────────────────────────────────────── */

/**
 * The redirect URI must match what is registered with the provider byte for
 * byte, so it is derived from one place rather than from the incoming request
 * — an attacker-controlled Host header must not be able to steer the callback.
 */
export function redirectUri(provider: IntegrationProvider): string {
  // appOrigin refuses to return localhost in production, because a loopback
  // redirect URI can never match what is registered with the provider.
  return `${appOrigin()}/api/integrations/${provider}/callback`;
}

/* ── Signed state ─────────────────────────────────────────────────────────── */

const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE = 'figbolt_oauth';

type StatePayload = {
  w: string; // workspace id
  u: string; // user id
  p: string; // provider
  n: string; // nonce, echoed in the cookie
  e: number; // expiry, epoch ms
};

function stateSecret(): string {
  const secret = env.AUTH_SECRET;
  if (!secret) {
    if (env.NODE_ENV === 'production') {
      throw new Error('AUTH_SECRET is required to sign OAuth state.');
    }
    return 'figbolt-dev-oauth-state';
  }
  return secret;
}

function sign(value: string): string {
  return createHmac('sha256', stateSecret()).update(value).digest('base64url');
}

export function encodeState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeState(state: string): StatePayload | null {
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;

  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return null;
  }

  if (typeof payload.e !== 'number' || payload.e < Date.now()) return null;
  if (!payload.w || !payload.u || !payload.p || !payload.n) return null;
  return payload;
}

/* ── PKCE ─────────────────────────────────────────────────────────────────── */

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/* ── Step 1: build the consent URL ────────────────────────────────────────── */

export type AuthorizeStart = {
  url: string;
  /** Opaque value to store in an httpOnly cookie and check on return. */
  cookieValue: string;
};

export function buildAuthorizeUrl(
  ctx: Ctx,
  provider: IntegrationProvider,
): AuthorizeStart {
  const spec = OAUTH[provider];
  const connector = findProvider(provider);
  if (!spec || !connector) throw new ValidationError(`${provider} does not support OAuth.`);

  const clientId = spec.clientId();
  if (!clientId || !spec.clientSecret()) {
    throw new ValidationError(
      `${connector.name} is missing its OAuth credentials. Set them and redeploy.`,
    );
  }
  if (!ctx.userId) throw new ValidationError('A signed-in user is required to connect.');

  const nonce = randomBytes(16).toString('base64url');
  const { verifier, challenge } = pkcePair();

  const state = encodeState({
    w: ctx.workspaceId,
    u: ctx.userId,
    p: provider,
    n: nonce,
    e: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: connector.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(spec.authorizeParams ?? {}),
  });

  return {
    url: `${spec.authorizeUrl}?${params.toString()}`,
    // The verifier must survive the round trip but never reach the provider or
    // any page, so it rides in an httpOnly cookie alongside the nonce.
    cookieValue: `${nonce}.${verifier}`,
  };
}

/* ── Step 2: exchange the code ────────────────────────────────────────────── */

export type ExchangedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  accountLabel: string | null;
};

export async function exchangeCode(
  provider: IntegrationProvider,
  code: string,
  verifier: string,
): Promise<ExchangedTokens> {
  const spec = OAUTH[provider];
  if (!spec) throw new ValidationError(`${provider} does not support OAuth.`);

  const clientId = spec.clientId();
  const clientSecret = spec.clientSecret();
  if (!clientId || !clientSecret) throw new ValidationError('OAuth credentials are not set.');

  const res = await fetch(spec.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(provider),
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // The body can echo parameters, so only the status is surfaced.
    throw new ValidationError(`The provider rejected the authorization code (${res.status}).`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token) throw new ValidationError('No access token in the provider response.');

  const label = spec.identify ? await spec.identify(json.access_token).catch(() => null) : null;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    accountLabel: label,
  };
}

/* ── Step 3: keep it usable ───────────────────────────────────────────────── */

/** Refresh this far before actual expiry, so an in-flight call cannot straddle it. */
const REFRESH_SKEW_MS = 2 * 60_000;

/**
 * A usable access token for this workspace's connection, refreshing first if
 * it is expired or close to it.
 *
 * Returns null rather than throwing when there is no connection — an
 * unconnected calendar is an ordinary state, and the caller falls back to the
 * .ics path.
 */
export async function freshAccessToken(
  ctx: Ctx,
  provider: IntegrationProvider,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({
      id: integrations.id,
      encryptedTokens: integrations.encryptedTokens,
      tokenExpiresAt: integrations.tokenExpiresAt,
      status: integrations.status,
    })
    .from(integrations)
    .where(and(scope(ctx, integrations), eq(integrations.provider, provider)))
    .limit(1);

  if (!row?.encryptedTokens) return null;

  let stored: { accessToken: string; refreshToken: string | null };
  try {
    stored = JSON.parse(decryptSecret(row.encryptedTokens));
  } catch {
    console.error(`[oauth] could not decrypt ${provider} tokens`);
    return null;
  }

  const expiresAt = row.tokenExpiresAt?.getTime() ?? null;
  const stale = expiresAt !== null && expiresAt - REFRESH_SKEW_MS <= Date.now();
  if (!stale) return stored.accessToken;

  if (!stored.refreshToken) {
    await markError(ctx, provider, 'The access token expired and no refresh token is stored. Reconnect.');
    return null;
  }

  const spec = OAUTH[provider];
  const clientId = spec?.clientId();
  const clientSecret = spec?.clientSecret();
  if (!spec || !clientId || !clientSecret) return null;

  try {
    const res = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      await markError(ctx, provider, `Token refresh failed (${res.status}). Reconnect the account.`);
      return null;
    }

    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      await markError(ctx, provider, 'Token refresh returned no access token.');
      return null;
    }

    await ctx.db
      .update(integrations)
      .set({
        encryptedTokens: encryptSecret(
          JSON.stringify({
            accessToken: json.access_token,
            // Providers may rotate the refresh token; keep the newest.
            refreshToken: json.refresh_token ?? stored.refreshToken,
          }),
        ),
        tokenExpiresAt: json.expires_in
          ? new Date(Date.now() + json.expires_in * 1000)
          : null,
        status: 'connected',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, row.id));

    return json.access_token;
  } catch (err) {
    await markError(ctx, provider, `Token refresh error: ${(err as Error).message.slice(0, 200)}`);
    return null;
  }
}

async function markError(ctx: Ctx, provider: IntegrationProvider, message: string): Promise<void> {
  await ctx.db
    .update(integrations)
    .set({ status: 'error', lastError: message, updatedAt: new Date() })
    .where(and(scope(ctx, integrations), eq(integrations.provider, provider)));
}
