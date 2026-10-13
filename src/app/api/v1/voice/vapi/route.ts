import { NextResponse } from 'next/server';
import { handleCallWebhook } from '@/server/voice/calls';

/**
 * Vapi reports call events here.
 *
 * Vapi does not authenticate webhooks whose URL is set per call (see
 * https://docs.vapi.ai/server-url/server-authentication), so nothing in the
 * body is trusted. The body only says *which* call to look at: the per-call
 * token in the URL must match, and the call itself is then fetched from
 * Vapi's API with our key. A forged request can at most make us re-check a
 * real call.
 */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const body = (await request.json().catch(() => null)) as {
    message?: { type?: string; call?: { id?: string } };
  } | null;

  const type = body?.message?.type;
  const callId = body?.message?.call?.id;
  if (!token || !callId || (type !== 'end-of-call-report' && type !== 'status-update')) {
    // Acknowledge anything else so the provider does not retry it forever.
    return NextResponse.json({ ok: true });
  }

  try {
    await handleCallWebhook(token, callId);
  } catch (err) {
    console.error('[voice] webhook handling failed:', (err as Error).message);
    // A 500 makes the provider retry, which is what we want for a transient fetch failure.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
