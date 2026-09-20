import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  accounts,
  approvals,
  automationRuns,
  automations,
  commitments,
  contacts,
  emails,
  notifications,
  opportunities,
  users,
  type NotificationKind,
} from '@/db/schema';
import { scope, scoped, type Ctx } from './context';
import { rawQuery } from './db-query';

/**
 * The unified Inbox.
 *
 * Every row must answer three questions, which is why they are three required
 * columns rather than one free-text body: **what happened**, **why it matters**,
 * and **what to do about it**. A notification that only says "deal at risk" has
 * moved work onto the user instead of off them.
 *
 * `dedupeKey` means a recurring condition updates its existing row rather than
 * stacking a new one every time the detector runs — the difference between an
 * inbox and a log.
 */

export const INBOX_SECTIONS: { kind: NotificationKind; label: string; description: string }[] = [
  { kind: 'needs_attention', label: 'Needs attention', description: 'Things that will get worse if ignored.' },
  { kind: 'agent_approval', label: 'Agent approvals', description: 'Proposed actions waiting on your decision.' },
  { kind: 'follow_up', label: 'Follow-ups', description: 'Conversations that have gone quiet.' },
  { kind: 'commitment', label: 'Commitments', description: 'Promises we made that are coming due.' },
  { kind: 'deal_risk', label: 'Deal risks', description: 'Deals whose health has deteriorated.' },
  { kind: 'customer_question', label: 'Customer questions', description: 'Unanswered questions from customers.' },
  { kind: 'automation_error', label: 'Automation errors', description: 'Automations or agents that failed.' },
];

type Draft = {
  kind: NotificationKind;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  recommendedAction?: { label: string; kind: string; payload?: Record<string, unknown> };
  severity: 'info' | 'warning' | 'critical';
  userId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  approvalId?: string | null;
  runId?: string | null;
  dedupeKey: string;
};

/**
 * Recompute derived inbox items.
 *
 * Approval and agent-run notifications are written at their source and are
 * left alone here; this only regenerates the state-derived ones, so resolving
 * an approval is never undone by a later rebuild.
 */
export async function rebuildInbox(ctx: Ctx): Promise<number> {
  await ctx.db
    .delete(notifications)
    .where(
      and(
        scope(ctx, notifications),
        inArray(notifications.kind, ['needs_attention', 'follow_up', 'commitment', 'deal_risk', 'customer_question']),
        isNull(notifications.readAt),
      ),
    );

  const drafts = (
    await Promise.all([
      overdueCommitments(ctx),
      commitmentsDueSoon(ctx),
      quietHighValueDeals(ctx),
      deterioratingDeals(ctx),
      unansweredCustomerQuestions(ctx),
      closeDatePassed(ctx),
      failedAutomations(ctx),
    ])
  ).flat();

  if (drafts.length === 0) return 0;

  for (const draft of drafts) {
    await ctx.db
      .insert(notifications)
      .values({
        workspaceId: ctx.workspaceId,
        userId: draft.userId ?? null,
        kind: draft.kind,
        title: draft.title,
        whatHappened: draft.whatHappened,
        whyItMatters: draft.whyItMatters,
        recommendedAction: draft.recommendedAction ?? null,
        severity: draft.severity,
        accountId: draft.accountId ?? null,
        contactId: draft.contactId ?? null,
        opportunityId: draft.opportunityId ?? null,
        approvalId: draft.approvalId ?? null,
        runId: draft.runId ?? null,
        dedupeKey: draft.dedupeKey,
      })
      .onConflictDoUpdate({
        target: [notifications.workspaceId, notifications.dedupeKey],
        set: {
          title: draft.title,
          whatHappened: draft.whatHappened,
          whyItMatters: draft.whyItMatters,
          recommendedAction: draft.recommendedAction ?? null,
          severity: draft.severity,
          resolvedAt: null,
          updatedAt: new Date(),
        },
      });
  }

  return drafts.length;
}

/* ── Detectors ────────────────────────────────────────────────────────────── */

async function overdueCommitments(ctx: Ctx): Promise<Draft[]> {
  const rows = await ctx.db
    .select({
      id: commitments.id,
      description: commitments.description,
      dueAt: commitments.dueAt,
      accountId: commitments.accountId,
      accountName: accounts.name,
      opportunityId: commitments.opportunityId,
      ownerLabel: commitments.ownerLabel,
      ownerUserId: commitments.ownerUserId,
      quote: commitments.sourceQuote,
    })
    .from(commitments)
    .leftJoin(accounts, eq(accounts.id, commitments.accountId))
    .where(
      scoped(
        ctx,
        commitments,
        eq(commitments.direction, 'we_owe'),
        inArray(commitments.status, ['open', 'overdue']),
        lte(commitments.dueAt, new Date()),
      ),
    )
    .limit(25);

  return rows.map((row) => {
    const daysLate = row.dueAt ? Math.floor((Date.now() - row.dueAt.getTime()) / 86_400_000) : 0;
    return {
      kind: 'commitment' as const,
      title: `Overdue: ${row.description}`,
      whatHappened: `We committed to this${row.dueAt ? ` by ${row.dueAt.toISOString().slice(0, 10)}` : ''} and it is ${daysLate} day${daysLate === 1 ? '' : 's'} past due.${row.quote ? ` Recorded from: "${truncate(row.quote, 160)}"` : ''}`,
      whyItMatters: `${row.accountName ?? 'The customer'} is waiting on us. A missed promise costs more credibility than the task costs time — and it is the fastest way to lose a champion.`,
      recommendedAction: {
        label: 'Create a task',
        kind: 'create_task',
        payload: { title: row.description, commitmentId: row.id, accountId: row.accountId, priority: 'urgent' },
      },
      severity: daysLate > 5 ? ('critical' as const) : ('warning' as const),
      userId: row.ownerUserId,
      accountId: row.accountId,
      opportunityId: row.opportunityId,
      dedupeKey: `commitment-overdue:${row.id}`,
    };
  });
}

async function commitmentsDueSoon(ctx: Ctx): Promise<Draft[]> {
  const rows = await ctx.db
    .select({
      id: commitments.id,
      description: commitments.description,
      dueAt: commitments.dueAt,
      accountId: commitments.accountId,
      accountName: accounts.name,
      opportunityId: commitments.opportunityId,
      ownerUserId: commitments.ownerUserId,
    })
    .from(commitments)
    .leftJoin(accounts, eq(accounts.id, commitments.accountId))
    .where(
      scoped(
        ctx,
        commitments,
        eq(commitments.direction, 'we_owe'),
        eq(commitments.status, 'open'),
        sql`${commitments.dueAt} > now() AND ${commitments.dueAt} <= now() + interval '3 days'`,
      ),
    )
    .limit(25);

  return rows.map((row) => ({
    kind: 'commitment' as const,
    title: `Due soon: ${row.description}`,
    whatHappened: `This is due ${row.dueAt ? row.dueAt.toISOString().slice(0, 10) : 'shortly'} and is still open.`,
    whyItMatters: `We told ${row.accountName ?? 'the customer'} we would do this. Delivering on time is the cheapest trust you can buy in a deal.`,
    recommendedAction: {
      label: 'Create a task',
      kind: 'create_task',
      payload: { title: row.description, commitmentId: row.id, accountId: row.accountId, priority: 'high' },
    },
    severity: 'info' as const,
    userId: row.ownerUserId,
    accountId: row.accountId,
    opportunityId: row.opportunityId,
    dedupeKey: `commitment-due:${row.id}`,
  }));
}

async function quietHighValueDeals(ctx: Ctx): Promise<Draft[]> {
  const rows = await rawQuery<{
    id: string;
    name: string;
    value: number;
    days_quiet: number;
    account_id: string;
    account_name: string;
    owner_id: string | null;
    last_event: string | null;
  }>(
    ctx,
    sql`
      SELECT o.id, o.name, o.value::float8 AS value,
             COALESCE(EXTRACT(EPOCH FROM (now() - o.last_interaction_at)) / 86400, 999)::int AS days_quiet,
             a.id AS account_id, a.name AS account_name, o.owner_id,
             (
               SELECT e.title FROM crm_events e
               WHERE e.opportunity_id = o.id AND e.importance >= 3
               ORDER BY e.occurred_at DESC LIMIT 1
             ) AS last_event
      FROM opportunities o
      JOIN accounts a ON a.id = o.account_id
      WHERE o.workspace_id = ${ctx.workspaceId}
        AND o.deleted_at IS NULL
        AND o.status = 'open'
        AND o.value >= 25000
        AND (o.last_interaction_at IS NULL OR o.last_interaction_at < now() - interval '10 days')
      ORDER BY o.value DESC
      LIMIT 20
    `,
  );

  return rows.map((row) => ({
    kind: 'follow_up' as const,
    title: `${row.account_name} — no contact for ${row.days_quiet} days`,
    whatHappened: `${row.name} ($${Math.round(Number(row.value)).toLocaleString()}) has had no recorded customer interaction for ${row.days_quiet} days.${row.last_event ? ` The last significant event was: ${row.last_event}.` : ''}`,
    whyItMatters: `This is one of the larger open deals. Silence after a substantive conversation is the most common precursor to a slip, and the cost of a follow-up is a few minutes.`,
    recommendedAction: {
      label: 'Draft a follow-up',
      kind: 'draft_email',
      payload: { opportunityId: row.id, accountId: row.account_id, purpose: 're-engagement' },
    },
    severity: row.days_quiet > 21 ? ('warning' as const) : ('info' as const),
    userId: row.owner_id,
    accountId: row.account_id,
    opportunityId: row.id,
    dedupeKey: `deal-quiet:${row.id}`,
  }));
}

async function deterioratingDeals(ctx: Ctx): Promise<Draft[]> {
  const rows = await ctx.db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      value: opportunities.value,
      healthScore: opportunities.healthScore,
      healthRationale: opportunities.healthRationale,
      accountId: opportunities.accountId,
      accountName: accounts.name,
      ownerId: opportunities.ownerId,
    })
    .from(opportunities)
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .where(
      scoped(
        ctx,
        opportunities,
        eq(opportunities.status, 'open'),
        lte(opportunities.healthScore, 45),
        sql`${opportunities.value} >= 25000`,
      ),
    )
    .orderBy(opportunities.healthScore)
    .limit(15);

  return rows.map((row) => {
    const topRisks = (row.healthRationale?.risks ?? []).slice(0, 3);
    return {
      kind: 'deal_risk' as const,
      title: `${row.name} — health ${row.healthScore}/100`,
      whatHappened:
        topRisks.length > 0
          ? `Health is ${row.healthScore}/100. The factors driving it down: ${topRisks.map((r) => r.label.toLowerCase()).join('; ')}.`
          : `Health is ${row.healthScore}/100.`,
      whyItMatters: `$${Math.round(row.value).toLocaleString()} is at risk. Each factor above is individually fixable — the score is not a verdict, it is a checklist.`,
      recommendedAction: { label: 'Open the deal', kind: 'open_record', payload: { type: 'opportunity', id: row.id } },
      severity: (row.healthScore ?? 100) < 25 ? ('critical' as const) : ('warning' as const),
      userId: row.ownerId,
      accountId: row.accountId,
      opportunityId: row.id,
      dedupeKey: `deal-health:${row.id}`,
    };
  });
}

async function unansweredCustomerQuestions(ctx: Ctx): Promise<Draft[]> {
  // An inbound message ending in a question with no outbound reply after it.
  const rows = await rawQuery<{
    id: string;
    subject: string;
    snippet: string;
    sent_at: string;
    account_id: string | null;
    account_name: string | null;
    contact_id: string | null;
    owner_id: string | null;
  }>(
    ctx,
    sql`
      SELECT e.id, e.subject, e.body_snippet AS snippet, e.sent_at::text AS sent_at,
             e.account_id, a.name AS account_name, e.contact_id, a.owner_id
      FROM emails e
      LEFT JOIN accounts a ON a.id = e.account_id
      WHERE e.workspace_id = ${ctx.workspaceId}
        AND e.deleted_at IS NULL
        AND e.direction = 'inbound'
        AND e.body_text LIKE '%?%'
        AND e.sent_at > now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM emails r
          WHERE r.thread_id = e.thread_id
            AND r.direction = 'outbound'
            AND r.sent_at > e.sent_at
        )
      ORDER BY e.sent_at DESC
      LIMIT 15
    `,
  );

  return rows.map((row) => {
    const days = Math.floor((Date.now() - new Date(row.sent_at).getTime()) / 86_400_000);
    return {
      kind: 'customer_question' as const,
      title: `Unanswered: ${row.subject}`,
      whatHappened: `${row.account_name ?? 'A customer'} asked a question ${days} day${days === 1 ? '' : 's'} ago and there is no reply on the thread.${row.snippet ? ` "${truncate(row.snippet, 140)}"` : ''}`,
      whyItMatters: `An unanswered question from an active buyer reads as disinterest, whatever the reason for the delay.`,
      recommendedAction: {
        label: 'Draft a reply',
        kind: 'draft_email',
        payload: { accountId: row.account_id, contactId: row.contact_id, replyToEmailId: row.id },
      },
      severity: days > 4 ? ('warning' as const) : ('info' as const),
      userId: row.owner_id,
      accountId: row.account_id,
      contactId: row.contact_id,
      dedupeKey: `email-unanswered:${row.id}`,
    };
  });
}

async function closeDatePassed(ctx: Ctx): Promise<Draft[]> {
  const rows = await ctx.db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      value: opportunities.value,
      expectedCloseDate: opportunities.expectedCloseDate,
      accountId: opportunities.accountId,
      ownerId: opportunities.ownerId,
    })
    .from(opportunities)
    .where(
      scoped(
        ctx,
        opportunities,
        eq(opportunities.status, 'open'),
        lte(opportunities.expectedCloseDate, new Date()),
      ),
    )
    .limit(15);

  return rows.map((row) => {
    const daysLate = row.expectedCloseDate
      ? Math.floor((Date.now() - row.expectedCloseDate.getTime()) / 86_400_000)
      : 0;
    return {
      kind: 'needs_attention' as const,
      title: `${row.name} — forecast date passed`,
      whatHappened: `The expected close date was ${row.expectedCloseDate?.toISOString().slice(0, 10)}, ${daysLate} day${daysLate === 1 ? '' : 's'} ago, and the deal is still open.`,
      whyItMatters: `A stale close date distorts the forecast for everyone downstream. Either the date needs moving or the deal needs a push.`,
      recommendedAction: { label: 'Open the deal', kind: 'open_record', payload: { type: 'opportunity', id: row.id } },
      severity: 'warning' as const,
      userId: row.ownerId,
      accountId: row.accountId,
      opportunityId: row.id,
      dedupeKey: `close-date-passed:${row.id}`,
    };
  });
}

async function failedAutomations(ctx: Ctx): Promise<Draft[]> {
  const rows = await ctx.db
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      name: automations.name,
      error: automationRuns.error,
      startedAt: automationRuns.startedAt,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(scoped(ctx, automationRuns, eq(automationRuns.status, 'failed')))
    .orderBy(desc(automationRuns.startedAt))
    .limit(10);

  return rows.map((row) => ({
    kind: 'automation_error' as const,
    title: `Automation failed: ${row.name}`,
    whatHappened: `The run on ${row.startedAt.toISOString().slice(0, 10)} failed: ${truncate(row.error ?? 'unknown error', 200)}`,
    whyItMatters: `While this is failing, whatever it was meant to catch is not being caught.`,
    recommendedAction: {
      label: 'Open the automation',
      kind: 'open_record',
      payload: { type: 'automation', id: row.automationId },
    },
    severity: 'warning' as const,
    dedupeKey: `automation-failed:${row.id}`,
  }));
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

export type InboxItem = typeof notifications.$inferSelect & {
  accountName: string | null;
  opportunityName: string | null;
};

export async function listInbox(
  ctx: Ctx,
  options: { kind?: NotificationKind; includeResolved?: boolean; limit?: number } = {},
): Promise<InboxItem[]> {
  const rows = await ctx.db
    .select({
      notification: notifications,
      accountName: accounts.name,
      opportunityName: opportunities.name,
    })
    .from(notifications)
    .leftJoin(accounts, eq(accounts.id, notifications.accountId))
    .leftJoin(opportunities, eq(opportunities.id, notifications.opportunityId))
    .where(
      scoped(
        ctx,
        notifications,
        options.kind ? eq(notifications.kind, options.kind) : undefined,
        options.includeResolved ? undefined : isNull(notifications.resolvedAt),
        // Items assigned to a specific user are private to them; unassigned
        // ones are workspace-wide.
        ctx.userId ? or(isNull(notifications.userId), eq(notifications.userId, ctx.userId)) : undefined,
        or(isNull(notifications.snoozedUntil), lte(notifications.snoozedUntil, new Date())),
      ),
    )
    .orderBy(
      sql`CASE ${notifications.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`,
      desc(notifications.createdAt),
    )
    .limit(options.limit ?? 100);

  return rows.map((r) => ({
    ...r.notification,
    accountName: r.accountName,
    opportunityName: r.opportunityName,
  }));
}

export async function inboxCounts(ctx: Ctx): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ kind: notifications.kind, count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      scoped(
        ctx,
        notifications,
        isNull(notifications.resolvedAt),
        ctx.userId ? or(isNull(notifications.userId), eq(notifications.userId, ctx.userId)) : undefined,
      ),
    )
    .groupBy(notifications.kind);

  const out: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    out[row.kind] = row.count;
    total += row.count;
  }
  out['total'] = total;
  return out;
}

export async function resolveNotification(ctx: Ctx, notificationId: string): Promise<void> {
  await ctx.db
    .update(notifications)
    .set({ resolvedAt: new Date(), readAt: new Date() })
    .where(and(scope(ctx, notifications), eq(notifications.id, notificationId)));
}

export async function snoozeNotification(ctx: Ctx, notificationId: string, days: number): Promise<void> {
  await ctx.db
    .update(notifications)
    .set({ snoozedUntil: new Date(Date.now() + days * 86_400_000), readAt: new Date() })
    .where(and(scope(ctx, notifications), eq(notifications.id, notificationId)));
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
