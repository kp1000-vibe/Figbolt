import { authenticateRequest, keyPermissions } from './auth';

/**
 * Authenticate a webhook from a recording device.
 *
 * Devices like Omi cannot set an Authorization header, so the workspace API
 * key may arrive as `?key=` in the URL instead. A header, when present, wins.
 * The key must be allowed to create records — use a dedicated key with only
 * that, so a leaked device URL can do no more than add transcripts and can be
 * revoked on its own.
 */
export async function authenticateDevice(request: Request) {
  const queryKey = new URL(request.url).searchParams.get('key');
  const authed =
    queryKey && !request.headers.get('authorization')
      ? new Request(request.url, { headers: { authorization: `Bearer ${queryKey}` } })
      : request;

  const auth = await authenticateRequest(authed);
  if ('failure' in auth) return auth;
  if (!keyPermissions(auth.ctx).includes('record:create')) {
    return { failure: { status: 403, error: 'This API key cannot create records.' } };
  }
  return auth;
}
