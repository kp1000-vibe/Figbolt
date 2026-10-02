import { and, eq } from 'drizzle-orm';
import { emails, meetings, meetingParticipants, transcripts } from '@/db/schema';
import { scope, type Ctx } from '../context';
import { ingestEmail, ingestMeeting } from '../memory/ingest';
import type { ResolvedConnector } from './connectors';
import type { SyncCursor, SyncedEmail, SyncedMeeting } from './providers';

/**
 * Turning what a connector pulled into records the memory engine can read.
 *
 * Kept out of manage.ts because it is a different concern: manage.ts owns
 * connection state and job bookkeeping, this owns the write path.
 *
 * Two properties matter here.
 *
 * **Idempotence.** Every pull is matched against `external_id` before it is
 * written. Connectors re-deliver: a page is retried, a cursor expires and the
 * window overlaps, a job is run twice by an impatient operator. Without this
 * the account timeline fills with triplicates and the extraction cost triples
 * with it.
 *
 * **Extraction happens per record, after the write.** A pulled email is stored
 * first and ingested second, so a failure in extraction leaves the raw message
 * intact and re-runnable rather than losing it. The raw source is always the
 * recoverable thing.
 */

export type SyncOutcome = {
  processed: number;
  created: number;
  skipped: number;
  nextCursor: SyncCursor;
  hasMore: boolean;
};

/** One page. The caller loops while `hasMore` and a budget remains. */
export async function applySyncPage(
  ctx: Ctx,
  resolved: ResolvedConnector,
  cursor: SyncCursor,
  limit: number,
): Promise<SyncOutcome> {
  if (resolved.kind === 'mail') {
    const page = await resolved.connector.pull(cursor, limit);
    let created = 0;
    for (const item of page.items) {
      if (await storeEmail(ctx, item, resolved.connector.provider)) created++;
    }
    return {
      processed: page.items.length,
      created,
      skipped: page.items.length - created,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  const page = await resolved.connector.pull(cursor, limit);
  let created = 0;
  for (const item of page.items) {
    if (await storeMeeting(ctx, item, resolved.connector.provider)) created++;
  }
  return {
    processed: page.items.length,
    created,
    skipped: page.items.length - created,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/* ── Email ────────────────────────────────────────────────────────────────── */

async function storeEmail(
  ctx: Ctx,
  item: SyncedEmail,
  provider: string,
): Promise<boolean> {
  const [existing] = await ctx.db
    .select({ id: emails.id })
    .from(emails)
    .where(and(scope(ctx, emails), eq(emails.externalId, item.externalId)))
    .limit(1);
  if (existing) return false;

  const [row] = await ctx.db
    .insert(emails)
    .values({
      workspaceId: ctx.workspaceId,
      externalId: item.externalId,
      provider,
      messageId: item.messageId,
      inReplyTo: item.inReplyTo,
      direction: item.direction,
      fromEmail: item.fromEmail,
      fromName: item.fromName,
      toEmails: item.toEmails,
      ccEmails: item.ccEmails,
      subject: item.subject,
      bodyText: item.bodyText,
      bodySnippet: item.bodyText.slice(0, 280),
      sentAt: item.sentAt,
      hasAttachments: item.hasAttachments,
    })
    .returning({ id: emails.id });

  if (!row) return false;

  // Extraction is best-effort: a message that cannot be summarised is still a
  // message, and the stored row can be reprocessed later.
  try {
    await ingestEmail(ctx, { emailId: row.id });
  } catch (err) {
    console.error(`[sync] extraction failed for email ${row.id}:`, (err as Error).message);
  }

  return true;
}

/* ── Meetings ─────────────────────────────────────────────────────────────── */

async function storeMeeting(
  ctx: Ctx,
  item: SyncedMeeting,
  provider: string,
): Promise<boolean> {
  const [existing] = await ctx.db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(scope(ctx, meetings), eq(meetings.externalId, item.externalId)))
    .limit(1);
  if (existing) return false;

  const [row] = await ctx.db
    .insert(meetings)
    .values({
      workspaceId: ctx.workspaceId,
      externalId: item.externalId,
      provider,
      title: item.title,
      description: item.description,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      location: item.location,
      meetingUrl: item.meetingUrl,
      recordingUrl: item.recordingUrl,
      status: item.startsAt.getTime() < Date.now() ? 'completed' : 'scheduled',
      origin: 'synced',
      participantEmails: item.participantEmails,
      transcriptionStatus: item.transcript ? 'done' : 'none',
    })
    .returning({ id: meetings.id });

  if (!row) return false;

  if (item.participantEmails.length > 0) {
    await ctx.db.insert(meetingParticipants).values(
      item.participantEmails.map((email) => ({
        workspaceId: ctx.workspaceId,
        meetingId: row.id,
        email,
        isOrganizer: email === item.organizerEmail,
        attended: true,
      })),
    );
  }

  // A connector that supplies a transcript (a notetaker, or Zoom) gives the
  // memory engine something to extract from immediately.
  if (item.transcript && item.transcript.length > 0) {
    const segments = item.transcript.map((line, index) => ({
      index,
      speaker: line.speaker,
      isCustomer: line.isCustomer,
      startSeconds: line.startSeconds,
      text: line.text,
    }));

    await ctx.db.insert(transcripts).values({
      workspaceId: ctx.workspaceId,
      meetingId: row.id,
      source: provider,
      language: 'en',
      segments,
      fullText: segments.map((s) => `${s.speaker}: ${s.text}`).join('\n'),
      durationSeconds: null,
    });
  }

  try {
    await ingestMeeting(ctx, row.id);
  } catch (err) {
    console.error(`[sync] extraction failed for meeting ${row.id}:`, (err as Error).message);
  }

  return true;
}
