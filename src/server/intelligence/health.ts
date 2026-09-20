import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  meetings,
  meetingParticipants,
  objections,
  opportunities,
  pipelineStages,
  type EvidenceBullet,
  type HealthRationale,
  type SourceRef,
} from '@/db/schema';
import { scope, scoped, type Ctx } from '../context';
import { rawQuery } from '../db-query';
import { engagementStats } from '../memory/timeline';
import { currentFacts } from '../memory/facts';

/**
 * Deal health scoring.
 *
 * Deliberately deterministic rather than model-generated. A number a rep is
 * asked to trust must be reproducible, explainable, and stable between reloads
 * — three things a free-form LLM score is not. The model's job is to *narrate*
 * this result, never to invent it.
 *
 * Every factor contributes a signed weight and carries the evidence that
 * triggered it, so the UI can always answer "why 72?" with specific records.
 */

const BASE = 50;

export type HealthResult = HealthRationale & {
  band: 'critical' | 'at_risk' | 'fair' | 'healthy' | 'strong';
};

export async function scoreOpportunityHealth(
  ctx: Ctx,
  opportunityId: string,
): Promise<HealthResult | null> {
  const [opp] = await ctx.db
    .select()
    .from(opportunities)
    .where(and(scope(ctx, opportunities), eq(opportunities.id, opportunityId)))
    .limit(1);
  if (!opp) return null;

  const [stage] = await ctx.db
    .select()
    .from(pipelineStages)
    .where(and(scope(ctx, pipelineStages), eq(pipelineStages.id, opp.stageId)))
    .limit(1);

  const [engagement, stakeholders, openObjections, openCommitments, facts, recentMeetings] =
    await Promise.all([
      engagementStats(ctx, { opportunityId }, 60),
      ctx.db
        .select({
          id: contacts.id,
          name: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`,
          buyingRole: contacts.buyingRole,
          lastInteractionAt: contacts.lastInteractionAt,
        })
        .from(contacts)
        .where(scoped(ctx, contacts, eq(contacts.accountId, opp.accountId))),
      ctx.db
        .select()
        .from(objections)
        .where(
          scoped(
            ctx,
            objections,
            eq(objections.opportunityId, opportunityId),
            inArray(objections.status, ['open', 'addressed']),
          ),
        ),
      ctx.db
        .select()
        .from(commitments)
        .where(
          scoped(
            ctx,
            commitments,
            eq(commitments.opportunityId, opportunityId),
            inArray(commitments.status, ['open', 'overdue']),
          ),
        ),
      currentFacts(ctx, 'opportunity', opportunityId),
      ctx.db
        .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt })
        .from(meetings)
        .where(
          scoped(
            ctx,
            meetings,
            eq(meetings.opportunityId, opportunityId),
            eq(meetings.status, 'completed'),
            gte(meetings.startsAt, new Date(Date.now() - 30 * 86_400_000)),
          ),
        )
        .orderBy(desc(meetings.startsAt)),
    ]);

  const positives: EvidenceBullet[] = [];
  const risks: EvidenceBullet[] = [];

  /* ── Engagement recency ─────────────────────────────────────────────────── */
  const daysSince = opp.lastInteractionAt
    ? Math.floor((Date.now() - opp.lastInteractionAt.getTime()) / 86_400_000)
    : null;

  if (daysSince === null) {
    risks.push({ label: 'No recorded customer interaction', weight: -14 });
  } else if (daysSince <= 7) {
    positives.push({
      label: 'Active conversation',
      detail: `Last customer interaction ${daysSince === 0 ? 'today' : `${daysSince}d ago`}.`,
      weight: 10,
    });
  } else if (daysSince <= 14) {
    positives.push({ label: 'Recent contact', detail: `Last interaction ${daysSince}d ago.`, weight: 4 });
  } else if (daysSince <= 30) {
    risks.push({
      label: 'Going quiet',
      detail: `No customer interaction for ${daysSince} days.`,
      weight: -10,
    });
  } else {
    risks.push({
      label: 'Stalled',
      detail: `No customer interaction for ${daysSince} days.`,
      weight: -20,
    });
  }

  /* ── Meeting cadence ────────────────────────────────────────────────────── */
  if (recentMeetings.length >= 3) {
    positives.push({
      label: 'Strong meeting cadence',
      detail: `${recentMeetings.length} meetings in the last 30 days.`,
      weight: 10,
      sources: recentMeetings.slice(0, 3).map(toMeetingRef),
    });
  } else if (recentMeetings.length >= 1) {
    positives.push({
      label: 'Meetings happening',
      detail: `${recentMeetings.length} meeting${recentMeetings.length === 1 ? '' : 's'} in the last 30 days.`,
      weight: 5,
      sources: recentMeetings.map(toMeetingRef),
    });
  } else {
    risks.push({ label: 'No meetings in 30 days', weight: -8 });
  }

  if (engagement.trend === 'declining') {
    risks.push({
      label: 'Declining engagement',
      detail: `Interaction volume dropped over the last 30 days (${engagement.perWeek}/week).`,
      weight: -9,
    });
  } else if (engagement.trend === 'rising') {
    positives.push({ label: 'Engagement rising', detail: `${engagement.perWeek} interactions/week.`, weight: 6 });
  }

  /* ── Buying committee coverage ──────────────────────────────────────────── */
  const roles = new Set(stakeholders.map((s) => s.buyingRole).filter(Boolean));

  if (roles.has('champion')) {
    const champion = stakeholders.find((s) => s.buyingRole === 'champion');
    positives.push({
      label: 'Champion identified',
      detail: champion ? `${champion.name} is advocating internally.` : undefined,
      weight: 12,
      sources: champion ? [{ type: 'contact', id: champion.id, label: champion.name }] : undefined,
    });
  } else {
    risks.push({ label: 'No identified champion', weight: -12 });
  }

  if (roles.has('economic_buyer')) {
    const buyer = stakeholders.find((s) => s.buyingRole === 'economic_buyer');
    const engagedRecently =
      buyer?.lastInteractionAt && Date.now() - buyer.lastInteractionAt.getTime() < 30 * 86_400_000;

    if (engagedRecently) {
      positives.push({
        label: 'Economic buyer engaged',
        detail: `${buyer!.name} has been active in the last 30 days.`,
        weight: 12,
        sources: [{ type: 'contact', id: buyer!.id, label: buyer!.name }],
      });
    } else {
      risks.push({
        label: "Economic buyer hasn't engaged recently",
        detail: buyer ? `${buyer.name} is known but has not been active in 30 days.` : undefined,
        weight: -10,
      });
    }
  } else {
    risks.push({ label: 'Economic buyer not identified', weight: -11 });
  }

  if (roles.has('blocker')) {
    const blocker = stakeholders.find((s) => s.buyingRole === 'blocker');
    risks.push({
      label: 'Known blocker in the account',
      detail: blocker?.name,
      weight: -8,
      sources: blocker ? [{ type: 'contact', id: blocker.id, label: blocker.name }] : undefined,
    });
  }

  if (roles.has('technical_evaluator')) {
    positives.push({ label: 'Technical evaluator involved', weight: 5 });
  }

  /* ── Objections ─────────────────────────────────────────────────────────── */
  const highObjections = openObjections.filter((o) => o.severity === 'high' && o.status === 'open');
  const highCategories = new Set(highObjections.map((o) => o.category));
  if (highObjections.length > 0) {
    risks.push({
      label: `Unresolved ${[...highCategories].join(' and ')} objection${highObjections.length === 1 ? '' : 's'}`,
      detail: highObjections.map((o) => o.summary).slice(0, 2).join(' · '),
      // Weighted by distinct concern area, not by mention count.
      weight: -9 * Math.min(highCategories.size, 3),
      sources: highObjections.slice(0, 3).map((o) => ({
        type: 'crm_event' as const,
        id: o.id,
        label: `Objection — ${o.category}`,
        occurredAt: o.occurredAt.toISOString(),
        snippet: o.sourceQuote ?? undefined,
      })),
    });
  }

  const addressed = openObjections.filter((o) => o.status === 'addressed');
  if (addressed.length > 0) {
    positives.push({
      label: `${addressed.length} objection${addressed.length === 1 ? '' : 's'} addressed`,
      weight: 4,
    });
  }

  const competitorObjections = openObjections.filter((o) => o.category === 'competitor');
  if (competitorObjections.length >= 2) {
    risks.push({
      label: 'Competitor mentioned repeatedly',
      detail: `${competitorObjections.length} separate mentions in recorded conversations.`,
      weight: -8,
    });
  }

  /* ── Commitments ────────────────────────────────────────────────────────── */
  const overdueOurs = openCommitments.filter(
    (c) => c.direction === 'we_owe' && c.dueAt && c.dueAt.getTime() < Date.now(),
  );
  if (overdueOurs.length > 0) {
    risks.push({
      label: `${overdueOurs.length} overdue commitment${overdueOurs.length === 1 ? '' : 's'} on our side`,
      detail: overdueOurs[0]!.description,
      weight: -6 * Math.min(overdueOurs.length, 3),
      sources: overdueOurs.slice(0, 3).map((c) => ({
        type: 'commitment' as const,
        id: c.id,
        label: c.description.slice(0, 60),
      })),
    });
  }

  /* ── Qualification completeness ─────────────────────────────────────────── */
  const factKeys = new Set(facts.map((f) => f.key));
  if (factKeys.has('budget')) {
    positives.push({ label: 'Budget confirmed', weight: 8 });
  } else {
    risks.push({ label: 'No confirmed budget', weight: -7 });
  }
  if (factKeys.has('timeline')) {
    positives.push({ label: 'Timeline agreed', weight: 6 });
  } else {
    risks.push({ label: 'No agreed implementation timeline', weight: -7 });
  }
  if (factKeys.has('decision_process')) {
    positives.push({ label: 'Decision process documented', weight: 5 });
  }

  /* ── Stage hygiene ──────────────────────────────────────────────────────── */
  const daysInStage = Math.floor((Date.now() - opp.stageEnteredAt.getTime()) / 86_400_000);
  if (daysInStage > 45 && opp.status === 'open') {
    risks.push({
      label: `${daysInStage} days in ${stage?.name ?? 'current stage'}`,
      detail: 'Well beyond the typical time in this stage.',
      weight: -8,
    });
  }

  if (opp.expectedCloseDate && opp.status === 'open') {
    const daysToClose = Math.ceil((opp.expectedCloseDate.getTime() - Date.now()) / 86_400_000);
    if (daysToClose < 0) {
      risks.push({
        label: `Close date passed ${Math.abs(daysToClose)} days ago`,
        detail: 'The forecast date needs revisiting.',
        weight: -10,
      });
    } else if (daysToClose < 14 && (stage?.probability ?? 0) < 60) {
      risks.push({
        label: 'Closing soon but early in the pipeline',
        detail: `${daysToClose} days to forecast close, still in ${stage?.name}.`,
        weight: -7,
      });
    }
  }

  return finalise(positives, risks, 'opportunity health v1');
}

export async function scoreAccountHealth(ctx: Ctx, accountId: string): Promise<HealthResult | null> {
  const [account] = await ctx.db
    .select()
    .from(accounts)
    .where(and(scope(ctx, accounts), eq(accounts.id, accountId)))
    .limit(1);
  if (!account) return null;

  const [engagement, openObjs, openOpps] = await Promise.all([
    engagementStats(ctx, { accountId }, 90),
    ctx.db
      .select()
      .from(objections)
      .where(scoped(ctx, objections, eq(objections.accountId, accountId), eq(objections.status, 'open'))),
    ctx.db
      .select({ id: opportunities.id, name: opportunities.name, value: opportunities.value })
      .from(opportunities)
      .where(scoped(ctx, opportunities, eq(opportunities.accountId, accountId), eq(opportunities.status, 'open'))),
  ]);

  const positives: EvidenceBullet[] = [];
  const risks: EvidenceBullet[] = [];

  const daysSince = account.lastInteractionAt
    ? Math.floor((Date.now() - account.lastInteractionAt.getTime()) / 86_400_000)
    : null;

  if (daysSince === null) {
    risks.push({ label: 'No recorded interaction', weight: -18 });
  } else if (daysSince <= 14) {
    positives.push({ label: 'Recent contact', detail: `${daysSince}d ago.`, weight: 12 });
  } else if (daysSince <= 45) {
    risks.push({ label: `Quiet for ${daysSince} days`, weight: -8 });
  } else {
    risks.push({ label: `No contact in ${daysSince} days`, weight: -18 });
  }

  if (engagement.trend === 'declining') {
    risks.push({ label: 'Engagement declining', detail: `${engagement.perWeek} interactions/week.`, weight: -10 });
  } else if (engagement.trend === 'rising') {
    positives.push({ label: 'Engagement rising', weight: 8 });
  }

  if (engagement.meetings >= 2) {
    positives.push({ label: `${engagement.meetings} meetings in 90 days`, weight: 8 });
  }

  // A relationship where they reach out too is healthier than one we carry.
  if (engagement.inbound > 0 && engagement.outbound > 0) {
    const ratio = engagement.inbound / Math.max(engagement.outbound, 1);
    if (ratio >= 0.6) {
      positives.push({ label: 'Two-way conversation', detail: 'The customer replies as often as we write.', weight: 8 });
    } else if (ratio < 0.25) {
      risks.push({ label: 'One-sided outreach', detail: 'We write far more than they reply.', weight: -9 });
    }
  }

  if (account.sentiment != null) {
    if (account.sentiment > 0.3) positives.push({ label: 'Positive sentiment', weight: 7 });
    else if (account.sentiment < -0.2) {
      risks.push({ label: 'Negative sentiment in recent conversations', weight: -12 });
    }
  }

  if (openObjs.length > 0) {
    risks.push({
      label: `${openObjs.length} open concern${openObjs.length === 1 ? '' : 's'}`,
      detail: openObjs.map((o) => o.summary).slice(0, 2).join(' · '),
      weight: -5 * Math.min(openObjs.length, 3),
    });
  }

  if (openOpps.length > 0) {
    positives.push({
      label: `${openOpps.length} open opportunit${openOpps.length === 1 ? 'y' : 'ies'}`,
      detail: `$${openOpps.reduce((s, o) => s + o.value, 0).toLocaleString()} in play.`,
      weight: 8,
    });
  }

  // Product usage and support load, when the workspace has them. These are
  // weighted heavily because they are behavioural: a customer can send warm
  // emails while quietly stopping using the product, and only one of those two
  // predicts the renewal.
  const retention = await retentionSignals(ctx, accountId);

  if (retention.priorActiveUsers >= 2) {
    if (retention.recentActiveUsers < 1) {
      risks.push({
        label: 'Product usage has gone dormant',
        detail: `Averaged ${Math.round(retention.priorActiveUsers)} daily active users last month, effectively zero now.`,
        weight: -22,
      });
    } else if (retention.recentActiveUsers < retention.priorActiveUsers * 0.7) {
      risks.push({
        label: 'Product usage falling',
        detail: `${Math.round(retention.priorActiveUsers)} → ${Math.round(retention.recentActiveUsers)} daily active users.`,
        weight: -14,
      });
    } else if (retention.recentActiveUsers > retention.priorActiveUsers * 1.15) {
      positives.push({
        label: 'Product usage growing',
        detail: `${Math.round(retention.priorActiveUsers)} → ${Math.round(retention.recentActiveUsers)} daily active users.`,
        weight: 12,
      });
    }
  }

  if (retention.powerUsers > 0) {
    positives.push({
      label: `${retention.powerUsers} power user${retention.powerUsers === 1 ? '' : 's'}`,
      detail: 'Doing real volume in the product — the most credible champions here.',
      weight: 9,
    });
  }

  if (retention.urgentTickets > 0) {
    risks.push({
      label: `${retention.urgentTickets} urgent support ticket${retention.urgentTickets === 1 ? '' : 's'}`,
      detail: 'Unresolved urgent issues dominate how a customer feels at renewal.',
      weight: -6 * Math.min(retention.urgentTickets, 3),
    });
  } else if (retention.openTickets >= 3) {
    risks.push({
      label: `${retention.openTickets} open support tickets`,
      weight: -7,
    });
  }

  if (retention.averageSatisfaction != null) {
    if (retention.averageSatisfaction >= 4) {
      positives.push({
        label: 'High support satisfaction',
        detail: `${retention.averageSatisfaction.toFixed(1)}/5 across rated tickets.`,
        weight: 7,
      });
    } else if (retention.averageSatisfaction <= 2.5) {
      risks.push({
        label: 'Low support satisfaction',
        detail: `${retention.averageSatisfaction.toFixed(1)}/5 across rated tickets.`,
        weight: -11,
      });
    }
  }

  return finalise(positives, risks, 'account health v1');
}

/**
 * Usage and support signals for one account.
 *
 * Reads account-level usage rows (`contact_id IS NULL`) for the metrics and
 * contact-level rows for champion counting, matching the convention in
 * `memory/external.ts`. Returns zeroes when nothing has been ingested, so an
 * account with no product data simply contributes no factors rather than
 * being penalised for a missing integration.
 */
async function retentionSignals(
  ctx: Ctx,
  accountId: string,
): Promise<{
  recentActiveUsers: number;
  priorActiveUsers: number;
  powerUsers: number;
  openTickets: number;
  urgentTickets: number;
  averageSatisfaction: number | null;
}> {
  const [row] = await rawQuery<{
    recent_users: number;
    prior_users: number;
    power_users: number;
    open_tickets: number;
    urgent_tickets: number;
    avg_satisfaction: number | null;
  }>(
    ctx,
    sql`
      SELECT
        COALESCE((
          SELECT AVG(u.active_users) FROM usage_daily u
          WHERE u.workspace_id = ${ctx.workspaceId} AND u.account_id = ${accountId}
            AND u.contact_id IS NULL AND u.day >= now() - interval '30 days'
        ), 0)::float8 AS recent_users,
        COALESCE((
          SELECT AVG(u.active_users) FROM usage_daily u
          WHERE u.workspace_id = ${ctx.workspaceId} AND u.account_id = ${accountId}
            AND u.contact_id IS NULL
            AND u.day < now() - interval '30 days' AND u.day >= now() - interval '60 days'
        ), 0)::float8 AS prior_users,
        COALESCE((
          SELECT COUNT(*) FROM (
            SELECT u.contact_id FROM usage_daily u
            WHERE u.workspace_id = ${ctx.workspaceId} AND u.account_id = ${accountId}
              AND u.contact_id IS NOT NULL AND u.day >= now() - interval '30 days'
            GROUP BY u.contact_id
            HAVING SUM(u.key_actions) >= 40
          ) AS champs
        ), 0)::int AS power_users,
        COALESCE((
          SELECT COUNT(*) FROM support_tickets t
          WHERE t.workspace_id = ${ctx.workspaceId} AND t.account_id = ${accountId}
            AND t.deleted_at IS NULL AND t.status IN ('open', 'pending')
        ), 0)::int AS open_tickets,
        COALESCE((
          SELECT COUNT(*) FROM support_tickets t
          WHERE t.workspace_id = ${ctx.workspaceId} AND t.account_id = ${accountId}
            AND t.deleted_at IS NULL AND t.status IN ('open', 'pending') AND t.priority = 'urgent'
        ), 0)::int AS urgent_tickets,
        (
          SELECT AVG(t.satisfaction) FROM support_tickets t
          WHERE t.workspace_id = ${ctx.workspaceId} AND t.account_id = ${accountId}
            AND t.deleted_at IS NULL AND t.satisfaction IS NOT NULL
            AND t.opened_at >= now() - interval '180 days'
        )::float8 AS avg_satisfaction
    `,
  );

  return {
    recentActiveUsers: Number(row?.recent_users ?? 0),
    priorActiveUsers: Number(row?.prior_users ?? 0),
    powerUsers: Number(row?.power_users ?? 0),
    openTickets: Number(row?.open_tickets ?? 0),
    urgentTickets: Number(row?.urgent_tickets ?? 0),
    averageSatisfaction: row?.avg_satisfaction == null ? null : Number(row.avg_satisfaction),
  };
}

function toMeetingRef(m: { id: string; title: string; startsAt: Date }): SourceRef {
  return {
    type: 'meeting',
    id: m.id,
    label: m.title,
    occurredAt: m.startsAt.toISOString(),
  };
}

/**
 * Rank-based decay applied to each list independently.
 *
 * Factors are correlated: a deal with an absent economic buyer usually also
 * lacks a confirmed budget and a timeline, because they are symptoms of the
 * same gap. Summing six such risks linearly drives every imperfect deal to
 * zero and destroys the score's ability to discriminate. Each successive
 * factor therefore contributes less, and the displayed weight is the decayed
 * one so the arithmetic a user sees actually adds up.
 */
const DECAY = [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.25, 0.2];

function applyDecay(bullets: EvidenceBullet[]): EvidenceBullet[] {
  return [...bullets]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .map((bullet, index) => ({
      ...bullet,
      weight: Math.round(bullet.weight * (DECAY[index] ?? 0.15)),
    }))
    .filter((bullet) => bullet.weight !== 0);
}

function finalise(positives: EvidenceBullet[], risks: EvidenceBullet[], method: string): HealthResult {
  const decayedPositives = applyDecay(positives);
  const decayedRisks = applyDecay(risks);

  const raw =
    BASE +
    decayedPositives.reduce((sum, p) => sum + p.weight, 0) +
    decayedRisks.reduce((sum, r) => sum + r.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    score,
    positives: decayedPositives.sort((a, b) => b.weight - a.weight),
    risks: decayedRisks.sort((a, b) => a.weight - b.weight),
    computedAt: new Date().toISOString(),
    method: `${method} · base ${BASE}, rank-decayed factors`,
    band:
      score < 25 ? 'critical' : score < 45 ? 'at_risk' : score < 65 ? 'fair' : score < 82 ? 'healthy' : 'strong',
  };
}

export function healthBand(score: number | null | undefined): HealthResult['band'] | null {
  if (score == null) return null;
  return score < 25 ? 'critical' : score < 45 ? 'at_risk' : score < 65 ? 'fair' : score < 82 ? 'healthy' : 'strong';
}
