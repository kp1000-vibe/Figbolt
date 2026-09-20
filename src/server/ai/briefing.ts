import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  accounts,
  agentRuns,
  agents,
  commitments,
  meetings,
  opportunities,
  pipelineStages,
  tasks,
  users,
  type SourceRef,
} from '@/db/schema';
import { scope, scoped, type Ctx } from '../context';
import { rawQuery } from '../db-query';

/**
 * The daily briefing.
 *
 * Computed, not generated. The rep is being asked to act on this first thing
 * in the morning, so it has to be exactly right and identical on every reload —
 * a model paraphrasing "3 deals need attention" into "a few deals" would make
 * it useless. Prose is assembled from the counts; the counts come from SQL.
 *
 * Priorities are ranked by *value at risk* rather than recency, because the
 * question the briefing answers is "what would hurt most if I ignored it".
 */

export type BriefingPriority = {
  kind: 'stalled_deal' | 'overdue_commitment' | 'declining_engagement' | 'close_date_passed' | 'unanswered_question';
  title: string;
  detail: string;
  why: string;
  valueAtRisk: number;
  accountId: string | null;
  accountName: string | null;
  opportunityId: string | null;
  sources: SourceRef[];
  actions: { label: string; kind: string; payload?: Record<string, unknown> }[];
};

export type Briefing = {
  greeting: string;
  summary: string[];
  priorities: BriefingPriority[];
  meetingsToday: {
    id: string;
    title: string;
    startsAt: Date;
    accountName: string | null;
    participantCount: number;
  }[];
  commitmentsDue: {
    id: string;
    description: string;
    dueAt: Date | null;
    accountName: string | null;
    overdue: boolean;
  }[];
  agentActivity: {
    id: string;
    agentName: string;
    status: string;
    summary: string | null;
    finishedAt: Date | null;
  }[];
  counts: {
    dealsNeedingAttention: number;
    commitmentsDueToday: number;
    meetingsToday: number;
    decliningDeals: number;
    pendingApprovals: number;
  };
};

export async function buildBriefing(ctx: Ctx, userName: string): Promise<Briefing> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);

  const [stalled, overdueCommitments, declining, closeDatePassed, todaysMeetings, dueToday, recentRuns, approvalCount] =
    await Promise.all([
      /* Open deals gone quiet, largest first. */
      rawQuery<{
        id: string;
        name: string;
        value: number;
        days_quiet: number;
        account_id: string;
        account_name: string;
        stage: string;
        last_event: string | null;
      }>(
        ctx,
        sql`
          SELECT o.id, o.name, o.value::float8 AS value,
                 COALESCE(EXTRACT(EPOCH FROM (now() - o.last_interaction_at)) / 86400, 999)::int AS days_quiet,
                 a.id AS account_id, a.name AS account_name, st.name AS stage,
                 (SELECT e.title FROM crm_events e
                  WHERE e.opportunity_id = o.id AND e.importance >= 3
                  ORDER BY e.occurred_at DESC LIMIT 1) AS last_event
          FROM opportunities o
          JOIN accounts a ON a.id = o.account_id
          JOIN pipeline_stages st ON st.id = o.stage_id
          WHERE o.workspace_id = ${ctx.workspaceId}
            AND o.deleted_at IS NULL
            AND o.status = 'open'
            AND (o.last_interaction_at IS NULL OR o.last_interaction_at < now() - interval '9 days')
          ORDER BY o.value DESC
          LIMIT 8
        `,
      ),

      ctx.db
        .select({
          id: commitments.id,
          description: commitments.description,
          dueAt: commitments.dueAt,
          accountId: commitments.accountId,
          accountName: accounts.name,
          opportunityId: commitments.opportunityId,
          quote: commitments.sourceQuote,
          sourceType: commitments.sourceType,
          sourceId: commitments.sourceId,
          value: opportunities.value,
        })
        .from(commitments)
        .leftJoin(accounts, eq(accounts.id, commitments.accountId))
        .leftJoin(opportunities, eq(opportunities.id, commitments.opportunityId))
        .where(
          scoped(
            ctx,
            commitments,
            eq(commitments.direction, 'we_owe'),
            inArray(commitments.status, ['open', 'overdue']),
            lt(commitments.dueAt, new Date()),
          ),
        )
        .orderBy(asc(commitments.dueAt))
        .limit(8),

      rawQuery<{ id: string; name: string; value: number; account_id: string; account_name: string; recent: number; earlier: number }>(
        ctx,
        sql`
          SELECT o.id, o.name, o.value::float8 AS value, a.id AS account_id, a.name AS account_name,
                 COUNT(act.id) FILTER (WHERE act.occurred_at >= now() - interval '21 days')::int AS recent,
                 COUNT(act.id) FILTER (
                   WHERE act.occurred_at < now() - interval '21 days'
                     AND act.occurred_at >= now() - interval '42 days'
                 )::int AS earlier
          FROM opportunities o
          JOIN accounts a ON a.id = o.account_id
          LEFT JOIN activities act ON act.opportunity_id = o.id
          WHERE o.workspace_id = ${ctx.workspaceId} AND o.deleted_at IS NULL AND o.status = 'open'
          GROUP BY o.id, o.name, o.value, a.id, a.name
          HAVING COUNT(act.id) FILTER (
                   WHERE act.occurred_at < now() - interval '21 days'
                     AND act.occurred_at >= now() - interval '42 days'
                 ) >= 2
             AND COUNT(act.id) FILTER (WHERE act.occurred_at >= now() - interval '21 days')
                 < COUNT(act.id) FILTER (
                     WHERE act.occurred_at < now() - interval '21 days'
                       AND act.occurred_at >= now() - interval '42 days'
                   )
          ORDER BY o.value DESC
          LIMIT 5
        `,
      ),

      ctx.db
        .select({
          id: opportunities.id,
          name: opportunities.name,
          value: opportunities.value,
          expectedCloseDate: opportunities.expectedCloseDate,
          accountId: opportunities.accountId,
          accountName: accounts.name,
        })
        .from(opportunities)
        .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
        .where(
          scoped(
            ctx,
            opportunities,
            eq(opportunities.status, 'open'),
            lt(opportunities.expectedCloseDate, new Date()),
          ),
        )
        .orderBy(desc(opportunities.value))
        .limit(5),

      ctx.db
        .select({
          id: meetings.id,
          title: meetings.title,
          startsAt: meetings.startsAt,
          accountName: accounts.name,
          participantCount: sql<number>`COALESCE(jsonb_array_length(${meetings.participantEmails}), 0)::int`,
        })
        .from(meetings)
        .leftJoin(accounts, eq(accounts.id, meetings.accountId))
        .where(
          scoped(
            ctx,
            meetings,
            gte(meetings.startsAt, startOfDay),
            lt(meetings.startsAt, endOfDay),
          ),
        )
        .orderBy(asc(meetings.startsAt)),

      ctx.db
        .select({
          id: commitments.id,
          description: commitments.description,
          dueAt: commitments.dueAt,
          accountName: accounts.name,
        })
        .from(commitments)
        .leftJoin(accounts, eq(accounts.id, commitments.accountId))
        .where(
          scoped(
            ctx,
            commitments,
            eq(commitments.direction, 'we_owe'),
            inArray(commitments.status, ['open', 'overdue']),
            lte(commitments.dueAt, endOfDay),
          ),
        )
        .orderBy(asc(commitments.dueAt))
        .limit(10),

      ctx.db
        .select({
          id: agentRuns.id,
          agentName: agents.name,
          status: agentRuns.status,
          summary: agentRuns.summary,
          finishedAt: agentRuns.finishedAt,
        })
        .from(agentRuns)
        .innerJoin(agents, eq(agents.id, agentRuns.agentId))
        .where(scope(ctx, agentRuns))
        .orderBy(desc(agentRuns.createdAt))
        .limit(5),

      ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(sql`approvals`)
        .where(sql`workspace_id = ${ctx.workspaceId} AND status = 'pending'`),
    ]);

  /* ── Assemble priorities ─────────────────────────────────────────────── */
  const priorities: BriefingPriority[] = [];

  for (const deal of stalled) {
    priorities.push({
      kind: 'stalled_deal',
      title: `${deal.account_name} — ${deal.days_quiet} days without contact`,
      detail: `${deal.name} · $${Math.round(Number(deal.value)).toLocaleString()} · ${deal.stage}`,
      why: deal.last_event
        ? `Last significant event: ${deal.last_event}. Silence after a substantive conversation is the most common precursor to a slip.`
        : 'No recorded customer interaction for over a week on an open deal.',
      valueAtRisk: Number(deal.value),
      accountId: deal.account_id,
      accountName: deal.account_name,
      opportunityId: deal.id,
      sources: [{ type: 'opportunity', id: deal.id, label: deal.name }],
      actions: [
        { label: 'Draft follow-up', kind: 'draft_email', payload: { opportunityId: deal.id } },
        { label: 'Open deal', kind: 'open_record', payload: { type: 'opportunity', id: deal.id } },
      ],
    });
  }

  for (const commitment of overdueCommitments) {
    const daysLate = commitment.dueAt
      ? Math.floor((Date.now() - commitment.dueAt.getTime()) / 86_400_000)
      : 0;
    priorities.push({
      kind: 'overdue_commitment',
      title: `Overdue promise to ${commitment.accountName ?? 'a customer'}`,
      detail: commitment.description,
      why: `We committed to this and it is ${daysLate} ${daysLate === 1 ? 'day' : 'days'} past due. A missed promise costs more credibility than the task costs time.`,
      // Weighted below stalled deals of equal size: a late document is
      // recoverable, a silent deal often isn't.
      valueAtRisk: Number(commitment.value ?? 0) * 0.6,
      accountId: commitment.accountId,
      accountName: commitment.accountName,
      opportunityId: commitment.opportunityId,
      sources:
        commitment.sourceType && commitment.sourceId
          ? [
              {
                type: commitment.sourceType as SourceRef['type'],
                id: commitment.sourceId,
                label: commitment.description.slice(0, 60),
                snippet: commitment.quote ?? undefined,
              },
            ]
          : [],
      actions: [
        {
          label: 'Create task',
          kind: 'create_task',
          payload: { commitmentId: commitment.id, title: commitment.description },
        },
      ],
    });
  }

  for (const deal of declining) {
    priorities.push({
      kind: 'declining_engagement',
      title: `${deal.account_name} — engagement falling`,
      detail: `${deal.name} · ${deal.earlier} interactions in the prior three weeks, ${deal.recent} since`,
      why: 'Interaction volume has more than halved. Cadence usually drops in the data before the customer says anything.',
      valueAtRisk: Number(deal.value) * 0.7,
      accountId: deal.account_id,
      accountName: deal.account_name,
      opportunityId: deal.id,
      sources: [{ type: 'opportunity', id: deal.id, label: deal.name }],
      actions: [{ label: 'Open deal', kind: 'open_record', payload: { type: 'opportunity', id: deal.id } }],
    });
  }

  for (const deal of closeDatePassed) {
    const daysLate = deal.expectedCloseDate
      ? Math.floor((Date.now() - deal.expectedCloseDate.getTime()) / 86_400_000)
      : 0;
    priorities.push({
      kind: 'close_date_passed',
      title: `${deal.accountName} — forecast date passed ${daysLate}d ago`,
      detail: `${deal.name} · $${Math.round(deal.value).toLocaleString()}`,
      why: 'A stale close date distorts the forecast for everyone downstream. Either move the date or push the deal.',
      valueAtRisk: deal.value * 0.5,
      accountId: deal.accountId,
      accountName: deal.accountName,
      opportunityId: deal.id,
      sources: [{ type: 'opportunity', id: deal.id, label: deal.name }],
      actions: [{ label: 'Open deal', kind: 'open_record', payload: { type: 'opportunity', id: deal.id } }],
    });
  }

  priorities.sort((a, b) => b.valueAtRisk - a.valueAtRisk);

  /* ── Assemble prose from the counts ──────────────────────────────────── */
  const counts = {
    dealsNeedingAttention: stalled.length,
    commitmentsDueToday: dueToday.length,
    meetingsToday: todaysMeetings.length,
    decliningDeals: declining.length,
    pendingApprovals: approvalCount[0]?.n ?? 0,
  };

  const summary: string[] = [];
  if (counts.dealsNeedingAttention > 0) {
    summary.push(
      `${counts.dealsNeedingAttention} ${counts.dealsNeedingAttention === 1 ? 'deal needs' : 'deals need'} attention`,
    );
  }
  if (counts.commitmentsDueToday > 0) {
    summary.push(
      `${counts.commitmentsDueToday} customer ${counts.commitmentsDueToday === 1 ? 'commitment' : 'commitments'} due`,
    );
  }
  if (counts.meetingsToday > 0) {
    summary.push(`${counts.meetingsToday} ${counts.meetingsToday === 1 ? 'meeting' : 'meetings'} today`);
  }
  if (counts.decliningDeals > 0) {
    summary.push(
      `${counts.decliningDeals} ${counts.decliningDeals === 1 ? 'opportunity' : 'opportunities'} showing declining engagement`,
    );
  }
  if (counts.pendingApprovals > 0) {
    summary.push(
      `${counts.pendingApprovals} agent ${counts.pendingApprovals === 1 ? 'action' : 'actions'} awaiting approval`,
    );
  }

  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'} ${userName.split(' ')[0]}`;

  return {
    greeting,
    summary,
    priorities: priorities.slice(0, 6),
    meetingsToday: todaysMeetings,
    commitmentsDue: dueToday.map((c) => ({
      id: c.id,
      description: c.description,
      dueAt: c.dueAt,
      accountName: c.accountName,
      overdue: Boolean(c.dueAt && c.dueAt.getTime() < Date.now()),
    })),
    agentActivity: recentRuns,
    counts,
  };
}
