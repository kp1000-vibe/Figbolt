import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The OAuth connect flow.
 *
 * These tests are about the four ways this flow could hand someone else's
 * calendar to the wrong person, not about the happy path — a real grant needs
 * Google on the other end. Every check below corresponds to an attack the
 * signed-state-plus-cookie design exists to stop.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env['AUTH_SECRET'] = 'test-secret-for-state-signing-only';
  process.env['APP_URL'] = 'https://figbolt.com';
  process.env['INTEGRATION_MODE'] = 'live';
  process.env['INTEGRATION_TOKEN_KEY'] = Buffer.alloc(32, 7).toString('base64url');
  process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'test-client-id';
  process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'test-client-secret';
  process.env['CALENDAR_PROVIDER'] = 'google';
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function oauth() {
  vi.resetModules();
  return import('@/server/integrations/oauth');
}

const CTX = { workspaceId: 'ws_1', userId: 'usr_1' } as never;

describe('the consent URL', () => {
  it('sends the user to Google with the parameters a real grant needs', async () => {
    const { buildAuthorizeUrl } = await oauth();
    const { url } = buildAuthorizeUrl(CTX, 'google_calendar');
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    // Without access_type=offline there is no refresh token, and every
    // connection would silently stop working after about an hour.
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('asks for write access, because read-only cannot create an event', async () => {
    const { buildAuthorizeUrl } = await oauth();
    const scopes =
      new URL(buildAuthorizeUrl(CTX, 'google_calendar').url).searchParams.get('scope') ?? '';

    expect(scopes).toContain('auth/calendar.events');
    expect(scopes).not.toContain('calendar.readonly');
  });

  it('derives the redirect URI from APP_URL, never from a request header', async () => {
    const { redirectUri } = await oauth();
    // A Host header an attacker controls must not be able to steer the
    // callback to their own origin.
    expect(redirectUri('google_calendar')).toBe(
      'https://figbolt.com/api/integrations/google_calendar/callback',
    );
  });

  it('keeps the PKCE verifier out of the URL', async () => {
    const { buildAuthorizeUrl } = await oauth();
    const { url, cookieValue } = buildAuthorizeUrl(CTX, 'google_calendar');
    const verifier = cookieValue.split('.')[1]!;

    expect(verifier.length).toBeGreaterThan(20);
    // The verifier's whole purpose is that only our server knows it.
    expect(url).not.toContain(verifier);
  });

  it('refuses a provider with no OAuth support', async () => {
    const { buildAuthorizeUrl } = await oauth();
    expect(() => buildAuthorizeUrl(CTX, 'stripe')).toThrow();
  });

  it('refuses when the credentials are absent', async () => {
    delete process.env['GOOGLE_OAUTH_CLIENT_SECRET'];
    const { buildAuthorizeUrl, oauthReady } = await oauth();
    expect(oauthReady('google_calendar')).toBe(false);
    expect(() => buildAuthorizeUrl(CTX, 'google_calendar')).toThrow();
  });

  it('stays off entirely unless INTEGRATION_MODE is live', async () => {
    process.env['INTEGRATION_MODE'] = 'demo';
    const { oauthReady } = await oauth();
    // Demo mode must never send anyone to a real consent screen.
    expect(oauthReady('google_calendar')).toBe(false);
    expect(oauthReady('outlook_calendar')).toBe(false);
  });
});

describe('the state parameter', () => {
  it('round-trips the workspace, user and provider', async () => {
    const { encodeState, decodeState } = await oauth();
    const decoded = decodeState(
      encodeState({ w: 'ws_1', u: 'usr_1', p: 'google_calendar', n: 'nonce', e: Date.now() + 60_000 }),
    );
    expect(decoded).toMatchObject({ w: 'ws_1', u: 'usr_1', p: 'google_calendar', n: 'nonce' });
  });

  it('rejects a tampered payload', async () => {
    const { encodeState, decodeState } = await oauth();
    const state = encodeState({
      w: 'ws_1',
      u: 'usr_1',
      p: 'google_calendar',
      n: 'nonce',
      e: Date.now() + 60_000,
    });

    // Swap the workspace for someone else's and keep the original signature.
    const [body, mac] = state.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    payload.w = 'ws_victim';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;

    expect(decodeState(forged)).toBeNull();
  });

  it('rejects an expired state', async () => {
    const { encodeState, decodeState } = await oauth();
    const stale = encodeState({
      w: 'ws_1',
      u: 'usr_1',
      p: 'google_calendar',
      n: 'nonce',
      e: Date.now() - 1000,
    });
    expect(decodeState(stale)).toBeNull();
  });

  it('rejects a state signed with a different secret', async () => {
    const { encodeState } = await oauth();
    const state = encodeState({
      w: 'ws_1',
      u: 'usr_1',
      p: 'google_calendar',
      n: 'nonce',
      e: Date.now() + 60_000,
    });

    process.env['AUTH_SECRET'] = 'a-completely-different-secret';
    const { decodeState } = await oauth();
    expect(decodeState(state)).toBeNull();
  });

  it('rejects malformed input rather than throwing', async () => {
    const { decodeState } = await oauth();
    for (const bad of ['', 'nope', 'a.b.c', '.', 'eyJ9.']) {
      expect(decodeState(bad), bad).toBeNull();
    }
  });

  it('issues a distinct nonce and verifier every time', async () => {
    const { buildAuthorizeUrl } = await oauth();
    const a = buildAuthorizeUrl(CTX, 'google_calendar').cookieValue;
    const b = buildAuthorizeUrl(CTX, 'google_calendar').cookieValue;
    // A reused nonce would make the cookie check meaningless.
    expect(a).not.toBe(b);
  });
});

describe('the callback route', () => {
  it('checks the state before it ever redeems the code', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/integrations/[provider]/callback/route.ts', 'utf8'),
    );

    const stateCheck = source.indexOf('decodeState(');
    const sessionCheck = source.indexOf('ctx.workspaceId !== state.w');
    const nonceCheck = source.indexOf('nonce !== state.n');
    const exchange = source.indexOf('exchangeCode(');

    for (const [label, index] of [
      ['state', stateCheck],
      ['session', sessionCheck],
      ['nonce', nonceCheck],
      ['exchange', exchange],
    ] as const) {
      expect(index, `${label} must be present`).toBeGreaterThan(-1);
    }

    // Order matters: each guard has to run before the code is spent.
    expect(stateCheck).toBeLessThan(exchange);
    expect(sessionCheck).toBeLessThan(exchange);
    expect(nonceCheck).toBeLessThan(exchange);
  });

  it('never puts a token in a redirect URL', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/integrations/[provider]/callback/route.ts', 'utf8'),
    );
    // A token in a query string ends up in browser history and server logs.
    expect(source).not.toMatch(/searchParams\.set\(\s*['"](access_token|token|code)['"]/);
    expect(source).not.toMatch(/console\.(log|info)\([^)]*token/i);
  });

  it('clears the verifier cookie on every path, so a code cannot be replayed', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/integrations/[provider]/callback/route.ts', 'utf8'),
    );
    expect(source).toContain('maxAge: 0');

    // Check the handler body only - the helpers below it legitimately return
    // a bare response. Every exit from GET must go through clear().
    // Check the handler body only - the helpers below it legitimately
    // return a bare response. Every exit from GET must go through clear().
    const start = source.indexOf('export async function GET');
    const end = source.indexOf('function clear(', start);
    expect(start, 'GET handler').toBeGreaterThan(-1);
    expect(end, 'clear helper').toBeGreaterThan(start);

    const body = source.slice(start, end);
    const exits = body.match(/return [^;]+/g) ?? [];
    expect(exits.length, 'the handler should have several exits').toBeGreaterThan(5);

    const unwrapped = exits.filter((line) => !line.includes('clear('));
    expect(unwrapped, 'every response must be wrapped in clear()').toEqual([]);
  });
});

describe('stored credentials', () => {
  it('encrypts tokens at rest rather than storing them readable', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/security/crypto');
    const payload = JSON.stringify({ accessToken: 'ya29.secret', refreshToken: '1//refresh' });
    const sealed = encryptSecret(payload);

    expect(sealed).not.toContain('ya29.secret');
    expect(sealed).not.toContain('1//refresh');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(decryptSecret(sealed)).toBe(payload);
  });

  it('fails closed on a tampered ciphertext instead of returning garbage', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/security/crypto');
    const sealed = encryptSecret('{"accessToken":"a"}');
    const parts = sealed.split('.');
    // Flip the last character of the ciphertext.
    const body = parts[3]!;
    parts[3] = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');

    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});
