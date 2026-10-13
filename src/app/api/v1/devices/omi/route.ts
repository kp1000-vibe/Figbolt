import { NextResponse } from 'next/server';
import { authenticateDevice } from '@/server/api/device-auth';
import { checkRateLimit } from '@/server/rate-limit';
import { ValidationError } from '@/server/context';
import { intakeTranscript, notetakerPayloadSchema } from '@/server/meetings/intake';
import { omiToNotetaker, type OmiConversation } from '@/server/meetings/devices/omi';

/**
 * Omi pendant webhook: point Omi's "conversation created" webhook at
 *
 *   https://figbolt.com/api/v1/devices/omi?key=<API key>
 *
 * Omi cannot send an Authorization header, so the key may come in the URL.
 * Use a dedicated key with only record:create, so a leaked device URL can do
 * no more than add transcripts, and can be revoked on its own.
 */
export async function POST(request: Request) {
  const auth = await authenticateDevice(request);
  if ('failure' in auth) {
    return NextResponse.json({ error: auth.failure.error }, { status: auth.failure.status });
  }
  const { ctx } = auth;

  const limit = await checkRateLimit(`omi:${ctx.workspaceId}`, 300, 3600);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many conversations this hour.' }, { status: 429 });
  }

  const conversation = (await request.json().catch(() => null)) as OmiConversation | null;
  const mapped = conversation ? omiToNotetaker(conversation) : null;
  if (!mapped) {
    // Discarded or empty: accepted, nothing to store. 200 so Omi does not retry.
    return NextResponse.json({ stored: false, detail: 'Nothing to store (discarded or no speech).' });
  }

  const parsed = notetakerPayloadSchema.safeParse(mapped);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Could not read that conversation.' }, { status: 422 });
  }

  try {
    const result = await intakeTranscript(ctx, parsed.data);
    return NextResponse.json(
      { stored: !result.duplicate, meetingId: result.meetingId, matchedBy: result.matchedBy },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error('[omi] intake failed:', err);
    return NextResponse.json({ error: 'Could not store that conversation.' }, { status: 500 });
  }
}
