import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { activities, crmEvents, type CrmEventType } from '@/db/schema';
import { scoped, type Ctx } from '../context';

/**
 * Timeline writes.
 *
 * Two feeds, kept separate on purpose:
 *  - `activities` answers "what happened" (an email arrived, a call was logged)
 *  - `crm_events` answers "what changed about this relationship" (an objection
 *    appeared, the economic buyer finally joined a call, sentiment dropped)
 *
 * The second is what the AI reasons over; collapsing them would bury three
 * meaningful state changes under two hundred routine emails.
 */

export type TimelineEventInput = {
  type: CrmEventType;
  subjectType: 'account' | 'contact' | 'opportunity';
  subjectId: string;
  accountId?: string | null;
  opportunityId?: string | null;
  contactId?: string | null;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
  /** 1-5. Drives timeline filtering and what reaches the daily briefing. */
  importance?: number;
  occurredAt?: Date;
  sourceType?: string | null;
  sourceId?: string | null;
};

const DEFAULT_IMPORTANCE: Partial<Record<CrmEventType, number>> = {
  email_sent: 1,
  email_received: 2,
  note_added: 1,
  field_updated: 1,
  record_created: 2,
  meeting_scheduled: 2,
  task_completed: 2,
  meeting_happened: 3,
  call_logged: 2,
  feature_requested: 3,
  pricing_discussed: 4,
  competitor_mentioned: 4,
  stakeholder_discovered: 4,
  commitment_made: 4,
  commitment_fulfilled: 3,
  renewal_discussed: 4,
  contract_sent: 5,
  stage_changed: 4,
  objection_identified: 4,
  sentiment_changed: 3,
  risk_detected: 5,
};

export async function addTimelineEvent(ctx: Ctx, input: TimelineEventInput): Promise<string> {
  const [row] = await ctx.db
    .insert(crmEvents)
    .values({
      workspaceId: ctx.workspaceId,
      type: input.type,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      accountId: input.accountId ?? null,
      opportunityId: input.opportunityId ?? null,
      contactId: input.contactId ?? null,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      actorLabel: ctx.actor.label,
      title: input.title,
      body: input.body ?? null,
      metadata: input.metadata ?? null,
      importance: input.importance ?? DEFAULT_IMPORTANCE[input.type] ?? 2,
      occurredAt: input.occurredAt ?? new Date(),
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
    })
    .returning({ id: crmEvents.id });
  return row!.id;
}

export type ActivityInput = {
  type: 'email' | 'meeting' | 'call' | 'note' | 'task' | 'stage_change' | 'field_change';
  subjectType: string;
  subjectId: string;
  accountId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  userId?: string | null;
  title: string;
  summary?: string | null;
  direction?: 'inbound' | 'outbound' | 'internal';
  occurredAt: Date;
  sourceType?: string | null;
  sourceId?: string | null;
};

export async function addActivity(ctx: Ctx, input: ActivityInput): Promise<void> {
  await ctx.db.insert(activities).values({
    workspaceId: ctx.workspaceId,
    type: input.type,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    accountId: input.accountId ?? null,
    contactId: input.contactId ?? null,
    opportunityId: input.opportunityId ?? null,
    userId: input.userId ?? ctx.userId,
    title: input.title,
    summary: input.summary ?? null,
    direction: input.direction ?? null,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
  });
}

export async function getTimeline(
  ctx: Ctx,
  subjectType: 'account' | 'contact' | 'opportunity',
  subjectId: string,
  options: { limit?: number; minImportance?: number; sinceDays?: number } = {},
) {
  return ctx.db
    .select()
    .from(crmEvents)
    .where(
      scoped(
        ctx,
        crmEvents,
        eq(crmEvents.subjectType, subjectType),
        eq(crmEvents.subjectId, subjectId),
        options.minImportance ? gte(crmEvents.importance, options.minImportance) : undefined,
        options.sinceDays
          ? gte(crmEvents.occurredAt, new Date(Date.now() - options.sinceDays * 86_400_000))
          : undefined,
      ),
    )
    .orderBy(desc(crmEvents.occurredAt))
    .limit(options.limit ?? 50);
}

export async function getRecentActivity(
  ctx: Ctx,
  filter: { accountId?: string; opportunityId?: string; contactId?: string; limit?: number },
) {
  return ctx.db
    .select()
    .from(activities)
    .where(
      scoped(
        ctx,
        activities,
        filter.accountId ? eq(activities.accountId, filter.accountId) : undefined,
        filter.opportunityId ? eq(activities.opportunityId, filter.opportunityId) : undefined,
        filter.contactId ? eq(activities.contactId, filter.contactId) : undefined,
      ),
    )
    .orderBy(desc(activities.occurredAt))
    .limit(filter.limit ?? 30);
}

/** Interaction cadence used by relationship intelligence and health scoring. */
export async function engagementStats(
  ctx: Ctx,
  filter: { accountId?: string; opportunityId?: string },
  windowDays = 90,
): Promise<{
  total: number;
  inbound: number;
  outbound: number;
  meetings: number;
  lastAt: Date | null;
  perWeek: number;
  trend: 'rising' | 'steady' | 'declining';
}> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await ctx.db
    .select({ direction: activities.direction, type: activities.type, occurredAt: activities.occurredAt })
    .from(activities)
    .where(
      scoped(
        ctx,
        activities,
        filter.accountId ? eq(activities.accountId, filter.accountId) : undefined,
        filter.opportunityId ? eq(activities.opportunityId, filter.opportunityId) : undefined,
        gte(activities.occurredAt, since),
      ),
    );

  const now = Date.now();
  const halfway = now - (windowDays / 2) * 86_400_000;
  const recent = rows.filter((r) => r.occurredAt.getTime() >= halfway).length;
  const earlier = rows.length - recent;

  // Require a meaningful gap before calling a trend, so noise doesn't read as
  // a signal on low-volume accounts.
  const trend: 'rising' | 'steady' | 'declining' =
    recent > earlier * 1.4 && recent >= 2
      ? 'rising'
      : recent * 1.4 < earlier && earlier >= 2
        ? 'declining'
        : 'steady';

  const lastAt = rows.reduce<Date | null>(
    (max, r) => (!max || r.occurredAt > max ? r.occurredAt : max),
    null,
  );

  return {
    total: rows.length,
    inbound: rows.filter((r) => r.direction === 'inbound').length,
    outbound: rows.filter((r) => r.direction === 'outbound').length,
    meetings: rows.filter((r) => r.type === 'meeting').length,
    lastAt,
    perWeek: Number(((rows.length / windowDays) * 7).toFixed(1)),
    trend,
  };
}
