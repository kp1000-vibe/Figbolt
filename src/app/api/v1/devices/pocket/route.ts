import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { authenticateDevice } from '@/server/api/device-auth';
import { checkRateLimit } from '@/server/rate-limit';
import { ValidationError } from '@/server/context';
import { intakeTranscript, notetakerPayloadSchema } from '@/server/meetings/intake';
import { pocketToNotetaker, verifyPocketSignature, type PocketEvent } from '@/server/meetings/devices/pocket';

/**
 * Pocket recorder webhook. In Pocket, add a webhook for transcription.completed
 * pointing at
 *
 *   https://figbolt.com/api/v1/devices/pocket?key=<API key>
 *
 * With POCKET_WEBHOOK_SECRET set, each delivery must also carry a valid
 * X-HeyPocket-Signature no more than five minutes old.
 */
export async function POST(request: Request) {
  const raw = await request.text();

  if (env.POCKET_WEBHOOK_SECRET) {
    const ok = verifyPocketSignature(
      env.POCKET_WEBHOOK_SECRET,
      raw,
      request.headers.get('x-heypocket-timestamp'),
      request.headers.get('x-heypocket-signature'),
    );
    if (!ok) return NextResponse.json({ error: 'Invalid or stale signature.' }, { status: 401 });
  }

  const auth = await authenticateDevice(request);
  if ('failure' in auth) {
    return NextResponse.json({ error: auth.failure.error }, { status: auth.failure.status });
  }
  const { ctx } = auth;

  const limit = await checkRateLimit(`pocket:${ctx.workspaceId}`, 300, 3600);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many recordings this hour.' }, { status: 429 });

  let event: PocketEvent | null = null;
  try {
    event = JSON.parse(raw) as PocketEvent;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const mapped = pocketToNotetaker(event);
  if (!mapped) {
    // Other events (summary.completed, recording.created...) carry nothing to store.
    return NextResponse.json({ stored: false, detail: 'Event acknowledged; nothing to store.' });
  }

  const parsed = notetakerPayloadSchema.safeParse(mapped);
  if (!parsed.success) return NextResponse.json({ error: 'Could not read that recording.' }, { status: 422 });

  try {
    const result = await intakeTranscript(ctx, parsed.data);
    return NextResponse.json(
      { stored: !result.duplicate, meetingId: result.meetingId, matchedBy: result.matchedBy },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error('[pocket] intake failed:', err);
    return NextResponse.json({ error: 'Could not store that recording.' }, { status: 500 });
  }
}
