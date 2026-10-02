import { NextResponse } from 'next/server';
import { authenticateRequest, keyPermissions } from '@/server/api/auth';
import { checkRateLimit } from '@/server/rate-limit';
import { ValidationError } from '@/server/context';
import { intakeTranscript, notetakerPayloadSchema } from '@/server/meetings/intake';

/**
 * Transcript intake, for any notetaker.
 *
 *   POST /api/v1/notetaker
 *   Authorization: Bearer fgb_…
 *
 * Granola, Fathom, Fireflies, Otter, Meetily, Amurex — each has a different
 * API and several have none that is public. Rather than six adapters to write
 * and maintain, this is one door they push through: a webhook where the tool
 * supports one, a short script or an automation step where it does not.
 *
 * **What arrives here is untrusted.** It is a customer talking, relayed by a
 * third-party tool over HTTP. It becomes evidence that a human reads and
 * never an instruction an agent follows: nothing in this path executes a CRM
 * action. The most it can do is cause actions to be *proposed* for approval,
 * which is the same gate a synced meeting goes through.
 *
 * Authenticated by a workspace API key, so no OAuth app is needed on the
 * notetaker's side — which is exactly why the free, self-hosted tools can use
 * it as easily as the commercial ones.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if ('failure' in auth) {
    return NextResponse.json({ error: auth.failure.error }, { status: auth.failure.status });
  }
  const { ctx } = auth;

  // Writing a meeting and its transcript is a record create.
  if (!keyPermissions(ctx).includes('record:create')) {
    return NextResponse.json(
      { error: 'This API key cannot create records.' },
      { status: 403 },
    );
  }

  // Generous, because a backfill of a quarter of meetings is a legitimate
  // first use — but bounded, because this endpoint triggers extraction.
  const limit = await checkRateLimit(`notetaker:${ctx.workspaceId}`, 300, 3600);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many transcripts this hour. Retry later.' },
      { status: 429, headers: { 'retry-after': '600' } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const parsed = notetakerPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid payload.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 422 },
    );
  }

  try {
    const result = await intakeTranscript(ctx, parsed.data);

    return NextResponse.json(
      {
        meetingId: result.meetingId,
        transcriptId: result.transcriptId,
        segments: result.segments,
        matchedBy: result.matchedBy,
        duplicate: result.duplicate,
        // Said explicitly so a webhook author can see a retry was absorbed
        // rather than wondering why nothing changed.
        detail: result.duplicate
          ? 'This meeting already had a transcript; nothing was changed.'
          : 'Transcript stored and extraction run.',
      },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[notetaker] intake failed:', err);
    return NextResponse.json({ error: 'Could not store that transcript.' }, { status: 500 });
  }
}

/** A GET that documents the contract, so the endpoint is discoverable. */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if ('failure' in auth) {
    return NextResponse.json({ error: auth.failure.error }, { status: auth.failure.status });
  }

  return NextResponse.json({
    endpoint: 'POST /api/v1/notetaker',
    description:
      'Send a meeting transcript from any notetaker. Matched to an existing meeting when possible, otherwise a new one is created.',
    authentication: 'Authorization: Bearer <workspace API key>',
    idempotency:
      'Send `externalId` — your tool\'s own id for the recording. A repeat is absorbed and reported as duplicate.',
    body: {
      externalId: 'string, optional but recommended',
      source: 'string, e.g. "granola" | "meetily" | "fireflies"',
      title: 'string, optional',
      startsAt: 'ISO-8601 timestamp, optional (defaults to now)',
      endsAt: 'ISO-8601 timestamp, optional',
      durationSeconds: 'number, optional',
      attendees: 'string[] of email addresses — used to find the account',
      organizerEmail: 'string, optional',
      recordingUrl: 'string, optional',
      segments: '[{ speaker, text, startSeconds?, isCustomer? }] — preferred',
      transcript: 'string — alternative to segments; parsed as "Speaker: line"',
      meetingId: 'string, optional — attach to a known meeting directly',
    },
    notes: [
      'Provide either `segments` or `transcript`.',
      'Attendee emails are how the transcript reaches the right account.',
      'Transcript content is treated as untrusted evidence; it never becomes an instruction.',
      'Extraction runs on arrival; proposed CRM actions still require human approval.',
    ],
  });
}
