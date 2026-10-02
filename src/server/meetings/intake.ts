import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { meetingParticipants, meetings, transcripts } from '@/db/schema';
import { scope, ValidationError, type Ctx } from '../context';
import { record } from '../audit';
import { resolveParties } from '../memory/ingest';

/**
 * One inbound door for every notetaker.
 *
 * Granola, Fathom, Fireflies, Otter, Meetily, Amurex — each has its own API,
 * its own auth, its own release cadence, and several have no public API at
 * all. Writing six adapters means maintaining six adapters, and guessing at
 * the ones that are undocumented.
 *
 * So the dependency is inverted: they push to us. One authenticated endpoint
 * accepts a transcript, normalises whatever shape it arrived in, and hands it
 * to the same pipeline a synced meeting goes through. A tool with webhooks
 * posts directly; one without is a short script or a Zapier step.
 *
 * Three things this is careful about.
 *
 * **The payload is untrusted.** It is a transcript of a customer talking,
 * arriving over HTTP from a third-party tool. It becomes evidence, never
 * instructions — the extraction layer already treats transcript content as
 * untrusted, and nothing here executes an action. The most this can do is
 * cause actions to be *proposed* for a human to approve.
 *
 * **It is idempotent.** Notetakers retry webhooks, and a retry must not
 * produce a second meeting and a second round of extraction. Matching is by
 * `externalId` first.
 *
 * **It attaches rather than duplicates.** A Granola note about a call that
 * Google Calendar already synced should land *on that meeting*, not beside
 * it. When no external id matches, an overlapping meeting with a shared
 * attendee is used instead.
 */

/* ── Payload ──────────────────────────────────────────────────────────────── */

const segmentSchema = z.object({
  speaker: z.string().max(120).optional(),
  text: z.string().min(1).max(20_000),
  startSeconds: z.coerce.number().min(0).max(86_400).optional(),
  /** Some tools label the speaker's side directly; trusted when present. */
  isCustomer: z.boolean().optional(),
});

export const notetakerPayloadSchema = z
  .object({
    /** The notetaker's own id for this recording. The idempotency key. */
    externalId: z.string().min(1).max(200).optional(),
    source: z.string().min(1).max(60).default('notetaker'),
    title: z.string().min(1).max(300).optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    durationSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
    meetingUrl: z.string().max(500).optional(),
    recordingUrl: z.string().max(500).optional(),
    /** Everyone on the call. Used to resolve the account. */
    attendees: z.array(z.string().max(320)).max(50).optional(),
    organizerEmail: z.string().max(320).optional(),
    /** Structured turns, when the tool provides them. */
    segments: z.array(segmentSchema).max(5_000).optional(),
    /** Or the whole thing as text — parsed as "Speaker: line". */
    transcript: z.string().max(500_000).optional(),
    /** Attach to a meeting already in Figbolt, bypassing the matcher. */
    meetingId: z.string().max(64).optional(),
  })
  .refine((v) => Boolean(v.segments?.length || v.transcript?.trim()), {
    message: 'Provide either `segments` or `transcript`.',
  });

export type NotetakerPayload = z.infer<typeof notetakerPayloadSchema>;

export type IntakeResult = {
  meetingId: string;
  transcriptId: string;
  segments: number;
  /** How the meeting was decided, so an operator can debug a mis-attachment. */
  matchedBy: 'explicit' | 'external_id' | 'overlap' | 'created';
  duplicate: boolean;
};

/* ── Intake ───────────────────────────────────────────────────────────────── */

/** Meetings this far either side of the stated start are candidates. */
const OVERLAP_WINDOW_MS = 2 * 60 * 60_000;

export async function intakeTranscript(
  ctx: Ctx,
  payload: NotetakerPayload,
): Promise<IntakeResult> {
  const attendees = [
    ...new Set(
      (payload.attendees ?? [])
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.includes('@')),
    ),
  ];

  const startsAt = parseDate(payload.startsAt) ?? new Date();
  const segments = normaliseSegments(payload);
  if (segments.length === 0) {
    throw new ValidationError('Could not read any speech from that payload.');
  }

  const match = await findMeeting(ctx, payload, startsAt, attendees);

  // A retry of a recording we already have must not re-extract.
  if (match.meetingId) {
    const [existing] = await ctx.db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(and(scope(ctx, transcripts), eq(transcripts.meetingId, match.meetingId)))
      .limit(1);

    if (existing) {
      return {
        meetingId: match.meetingId,
        transcriptId: existing.id,
        segments: segments.length,
        matchedBy: match.matchedBy,
        duplicate: true,
      };
    }
  }

  const meetingId = match.meetingId ?? (await createMeeting(ctx, payload, startsAt, attendees));

  // Attribution: a tool that labels sides is trusted; otherwise anyone not
  // recognised as a teammate is treated as the customer, which is the safe
  // direction — see transcribe.ts.
  const resolved = await attribute(ctx, meetingId, segments);
  const fullText = resolved.map((s) => `${s.speaker}: ${s.text}`).join('\n');

  const [row] = await ctx.db
    .insert(transcripts)
    .values({
      workspaceId: ctx.workspaceId,
      meetingId,
      source: payload.source,
      language: 'en',
      segments: resolved,
      fullText,
      durationSeconds: payload.durationSeconds ?? null,
    })
    .returning({ id: transcripts.id });

  await ctx.db
    .update(meetings)
    .set({
      transcriptionStatus: 'done',
      transcriptionError: null,
      ...(payload.recordingUrl ? { recordingUrl: payload.recordingUrl } : {}),
    })
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));

  await record(ctx, {
    action: 'meeting.transcript_received',
    resourceType: 'meeting',
    resourceId: meetingId,
    riskLevel: 'low',
    metadata: {
      source: payload.source,
      segments: resolved.length,
      matchedBy: match.matchedBy,
      ...(payload.externalId ? { externalId: payload.externalId } : {}),
    },
  });

  // Extraction last, and best-effort: the transcript is the valuable artefact
  // and must survive an extractor failure.
  try {
    const { ingestMeeting } = await import('../memory/ingest');
    await ingestMeeting(ctx, meetingId);
  } catch (err) {
    console.error(`[intake] extraction failed for ${meetingId}:`, (err as Error).message);
  }

  return {
    meetingId,
    transcriptId: row!.id,
    segments: resolved.length,
    matchedBy: match.matchedBy,
    duplicate: false,
  };
}

/* ── Matching ─────────────────────────────────────────────────────────────── */

async function findMeeting(
  ctx: Ctx,
  payload: NotetakerPayload,
  startsAt: Date,
  attendees: string[],
): Promise<{ meetingId: string | null; matchedBy: IntakeResult['matchedBy'] }> {
  if (payload.meetingId) {
    const [row] = await ctx.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(scope(ctx, meetings), eq(meetings.id, payload.meetingId)))
      .limit(1);
    if (!row) throw new ValidationError('No such meeting in this workspace.');
    return { meetingId: row.id, matchedBy: 'explicit' };
  }

  if (payload.externalId) {
    const [row] = await ctx.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(scope(ctx, meetings), eq(meetings.externalId, payload.externalId)))
      .limit(1);
    if (row) return { meetingId: row.id, matchedBy: 'external_id' };
  }

  // A notetaker recording of a call the calendar already synced. Without this
  // every Granola note would create a second, duplicate meeting beside the
  // real one.
  if (attendees.length > 0) {
    const candidates = await ctx.db
      .select({
        id: meetings.id,
        participantEmails: meetings.participantEmails,
        startsAt: meetings.startsAt,
      })
      .from(meetings)
      .where(
        and(
          scope(ctx, meetings),
          gte(meetings.startsAt, new Date(startsAt.getTime() - OVERLAP_WINDOW_MS)),
          lte(meetings.startsAt, new Date(startsAt.getTime() + OVERLAP_WINDOW_MS)),
        ),
      );

    let best: { id: string; shared: number; distance: number } | null = null;
    for (const candidate of candidates) {
      const emails = new Set(candidate.participantEmails.map((e) => e.toLowerCase()));
      const shared = attendees.filter((a) => emails.has(a)).length;
      if (shared === 0) continue;

      const distance = Math.abs(candidate.startsAt.getTime() - startsAt.getTime());
      // Most shared attendees wins; nearest start time breaks a tie.
      if (!best || shared > best.shared || (shared === best.shared && distance < best.distance)) {
        best = { id: candidate.id, shared, distance };
      }
    }

    if (best) return { meetingId: best.id, matchedBy: 'overlap' };
  }

  return { meetingId: null, matchedBy: 'created' };
}

async function createMeeting(
  ctx: Ctx,
  payload: NotetakerPayload,
  startsAt: Date,
  attendees: string[],
): Promise<string> {
  const parties = await resolveParties(ctx, attendees);
  const endsAt =
    parseDate(payload.endsAt) ??
    (payload.durationSeconds ? new Date(startsAt.getTime() + payload.durationSeconds * 1000) : null);

  const [row] = await ctx.db
    .insert(meetings)
    .values({
      workspaceId: ctx.workspaceId,
      externalId: payload.externalId ?? null,
      provider: payload.source,
      title: payload.title ?? 'Recorded meeting',
      startsAt,
      endsAt,
      meetingUrl: payload.meetingUrl ?? null,
      recordingUrl: payload.recordingUrl ?? null,
      status: 'completed',
      origin: 'synced',
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      participantEmails: attendees,
      transcriptionStatus: 'done',
    })
    .returning({ id: meetings.id });

  if (attendees.length > 0) {
    await ctx.db.insert(meetingParticipants).values(
      attendees.map((email) => ({
        workspaceId: ctx.workspaceId,
        meetingId: row!.id,
        email,
        isOrganizer: email === payload.organizerEmail?.toLowerCase(),
        attended: true,
      })),
    );
  }

  return row!.id;
}

/* ── Normalising ──────────────────────────────────────────────────────────── */

type RawSegment = { speaker: string; text: string; startSeconds: number; isCustomer?: boolean };

export function normaliseSegments(payload: NotetakerPayload): RawSegment[] {
  if (payload.segments?.length) {
    return payload.segments
      .map((s) => ({
        speaker: s.speaker?.trim() || 'Unknown speaker',
        text: s.text.trim(),
        startSeconds: Math.round(s.startSeconds ?? 0),
        ...(s.isCustomer === undefined ? {} : { isCustomer: s.isCustomer }),
      }))
      .filter((s) => s.text.length > 0);
  }

  return parseTranscriptText(payload.transcript ?? '');
}

/**
 * Parse a plain-text transcript.
 *
 * Handles the two shapes these tools emit: `Name: said something`, and a
 * timestamped `[00:14:32] Name: said something`. A line that matches neither
 * continues the previous speaker, so a wrapped paragraph stays intact rather
 * than becoming a speaker called "and then we".
 */
export function parseTranscriptText(text: string): RawSegment[] {
  const out: RawSegment[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const stamped = line.match(/^[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*(?:-\s*)?(.*)$/);
    const body = stamped ? (stamped[2] ?? '').trim() : line;
    const seconds = stamped ? toSeconds(stamped[1]!) : null;

    const speech = body.match(/^([A-Za-z][\w .'-]{0,40}):\s+(.*)$/);
    if (speech && speech[2]!.trim()) {
      out.push({
        speaker: speech[1]!.trim(),
        text: speech[2]!.trim(),
        startSeconds: seconds ?? 0,
      });
      continue;
    }

    if (out.length > 0 && body) {
      out[out.length - 1]!.text += ` ${body}`;
    } else if (body) {
      out.push({ speaker: 'Unknown speaker', text: body, startSeconds: seconds ?? 0 });
    }
  }

  return out;
}

function toSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return 0;
}

/** Decide which side each speaker is on. See transcribe.ts for the reasoning. */
async function attribute(
  ctx: Ctx,
  meetingId: string,
  segments: RawSegment[],
): Promise<{ index: number; speaker: string; isCustomer: boolean; startSeconds: number; text: string }[]> {
  const { attributeSpeakers } = await import('./transcribe');

  const resolved = await attributeSpeakers(
    ctx,
    meetingId,
    segments.map((s) => ({ speaker: s.speaker, text: s.text, startSeconds: s.startSeconds })),
  );

  // A tool that labels the side itself is more reliable than our name match.
  return resolved.map((segment, i) => {
    const stated = segments[i]?.isCustomer;
    return stated === undefined ? segment : { ...segment, isCustomer: stated };
  });
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
