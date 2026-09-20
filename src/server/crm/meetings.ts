import { and, asc, desc, eq, gte, ilike, inArray, lt, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  meetingParticipants,
  meetings,
  objections,
  opportunities,
  productSignals,
  transcripts,
  users,
} from '@/db/schema';
import { NotFoundError, scope, scoped, type Ctx } from '../context';

export type MeetingFilters = {
  query?: string;
  accountId?: string;
  opportunityId?: string;
  /** 'upcoming' | 'past' | 'unprocessed' */
  bucket?: string;
  limit?: number;
};

export async function listMeetings(ctx: Ctx, filters: MeetingFilters = {}) {
  const rows = await ctx.db
    .select({
      id: meetings.id,
      title: meetings.title,
      startsAt: meetings.startsAt,
      endsAt: meetings.endsAt,
      status: meetings.status,
      sentiment: meetings.sentiment,
      intelligence: meetings.intelligence,
      processedAt: meetings.processedAt,
      accountId: meetings.accountId,
      accountName: accounts.name,
      opportunityId: meetings.opportunityId,
      opportunityName: opportunities.name,
      organizerName: users.name,
      participantCount: sql<number>`COALESCE(jsonb_array_length(${meetings.participantEmails}), 0)::int`,
      hasTranscript: sql<boolean>`EXISTS (
        SELECT 1 FROM transcripts t WHERE t.meeting_id = ${meetings.id} AND t.deleted_at IS NULL
      )`,
    })
    .from(meetings)
    .leftJoin(accounts, eq(accounts.id, meetings.accountId))
    .leftJoin(opportunities, eq(opportunities.id, meetings.opportunityId))
    .leftJoin(users, eq(users.id, meetings.organizerId))
    .where(
      scoped(
        ctx,
        meetings,
        filters.query ? ilike(meetings.title, `%${filters.query}%`) : undefined,
        filters.accountId ? eq(meetings.accountId, filters.accountId) : undefined,
        filters.opportunityId ? eq(meetings.opportunityId, filters.opportunityId) : undefined,
        filters.bucket === 'upcoming' ? gte(meetings.startsAt, new Date()) : undefined,
        filters.bucket === 'past' ? lt(meetings.startsAt, new Date()) : undefined,
        filters.bucket === 'unprocessed' ? sql`${meetings.processedAt} IS NULL` : undefined,
      ),
    )
    .orderBy(desc(meetings.startsAt))
    .limit(Math.min(filters.limit ?? 60, 200));

  return rows;
}

export async function getMeetingDetail(ctx: Ctx, meetingId: string) {
  const [row] = await ctx.db
    .select({
      meeting: meetings,
      accountName: accounts.name,
      accountId: accounts.id,
      opportunityName: opportunities.name,
      opportunityId: opportunities.id,
      opportunityValue: opportunities.value,
      organizerName: users.name,
    })
    .from(meetings)
    .leftJoin(accounts, eq(accounts.id, meetings.accountId))
    .leftJoin(opportunities, eq(opportunities.id, meetings.opportunityId))
    .leftJoin(users, eq(users.id, meetings.organizerId))
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)))
    .limit(1);

  if (!row) throw new NotFoundError('Meeting', meetingId);
  const meeting = row.meeting;

  const [[transcript], participants, meetingCommitments, meetingObjections, signals] =
    await Promise.all([
      ctx.db
        .select()
        .from(transcripts)
        .where(scoped(ctx, transcripts, eq(transcripts.meetingId, meetingId)))
        .limit(1),

      ctx.db
        .select({
          id: meetingParticipants.id,
          email: meetingParticipants.email,
          name: meetingParticipants.name,
          isOrganizer: meetingParticipants.isOrganizer,
          attended: meetingParticipants.attended,
          talkRatio: meetingParticipants.talkRatio,
          contactId: meetingParticipants.contactId,
          userId: meetingParticipants.userId,
          buyingRole: contacts.buyingRole,
          title: contacts.title,
        })
        .from(meetingParticipants)
        .leftJoin(contacts, eq(contacts.id, meetingParticipants.contactId))
        .where(scoped(ctx, meetingParticipants, eq(meetingParticipants.meetingId, meetingId)))
        .orderBy(desc(meetingParticipants.isOrganizer)),

      // Everything extracted from this meeting, whether the source row points
      // at the meeting or at its transcript.
      ctx.db
        .select()
        .from(commitments)
        .where(
          scoped(
            ctx,
            commitments,
            sql`(${commitments.sourceType} = 'meeting' AND ${commitments.sourceId} = ${meetingId})
                OR (${commitments.sourceType} = 'transcript' AND ${commitments.sourceId} IN (
                  SELECT id FROM transcripts WHERE meeting_id = ${meetingId}
                ))`,
          ),
        )
        .orderBy(asc(commitments.sourceSegmentIndex)),

      ctx.db
        .select()
        .from(objections)
        .where(
          scoped(
            ctx,
            objections,
            sql`(${objections.sourceType} = 'meeting' AND ${objections.sourceId} = ${meetingId})
                OR (${objections.sourceType} = 'transcript' AND ${objections.sourceId} IN (
                  SELECT id FROM transcripts WHERE meeting_id = ${meetingId}
                ))`,
          ),
        ),

      ctx.db
        .select()
        .from(productSignals)
        .where(
          scoped(
            ctx,
            productSignals,
            sql`(${productSignals.sourceType} = 'meeting' AND ${productSignals.sourceId} = ${meetingId})
                OR (${productSignals.sourceType} = 'transcript' AND ${productSignals.sourceId} IN (
                  SELECT id FROM transcripts WHERE meeting_id = ${meetingId}
                ))`,
          ),
        ),
    ]);

  return {
    meeting,
    account: row.accountId ? { id: row.accountId, name: row.accountName } : null,
    opportunity: row.opportunityId
      ? { id: row.opportunityId, name: row.opportunityName, value: row.opportunityValue }
      : null,
    organizerName: row.organizerName,
    transcript: transcript ?? null,
    participants,
    commitments: meetingCommitments,
    objections: meetingObjections,
    signals,
  };
}

/** Resolve a transcript id to its meeting, so citations can deep-link. */
export async function findMeetingByTranscript(ctx: Ctx, transcriptId: string) {
  const [row] = await ctx.db
    .select({ meetingId: transcripts.meetingId })
    .from(transcripts)
    .where(and(scope(ctx, transcripts), eq(transcripts.id, transcriptId)))
    .limit(1);
  return row?.meetingId ?? null;
}

export async function meetingCounts(ctx: Ctx) {
  const [row] = await ctx.db
    .select({
      total: sql<number>`count(*)::int`,
      upcoming: sql<number>`count(*) FILTER (WHERE ${meetings.startsAt} >= now())::int`,
      past: sql<number>`count(*) FILTER (WHERE ${meetings.startsAt} < now())::int`,
      unprocessed: sql<number>`count(*) FILTER (WHERE ${meetings.processedAt} IS NULL)::int`,
    })
    .from(meetings)
    .where(scope(ctx, meetings));

  return {
    total: row?.total ?? 0,
    upcoming: row?.upcoming ?? 0,
    past: row?.past ?? 0,
    unprocessed: row?.unprocessed ?? 0,
  };
}
