import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  accounts,
  activities,
  commitments,
  contacts,
  crmEvents,
  emails,
  meetings,
  notes,
  objections,
  opportunities,
  pipelineStages,
  pipelines,
  productSignals,
  tasks,
  users,
} from '@/db/schema';
import { NotFoundError, scope, scoped, ValidationError, type Ctx } from '../context';
import { record, diff } from '../audit';
import { addActivity, addTimelineEvent, engagementStats } from '../memory/timeline';
import { currentFacts } from '../memory/facts';
import { rawQuery } from '../db-query';

export type OpportunityFilters = {
  query?: string;
  status?: 'open' | 'won' | 'lost';
  stageId?: string;
  ownerId?: string;
  accountId?: string;
  minValue?: number;
  flag?: 'at_risk' | 'quiet' | 'closing_soon' | 'overdue_close';
  sort?: 'value' | 'close' | 'health' | 'activity' | 'name' | 'stage';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type OpportunityListRow = {
  id: string;
  name: string;
  value: number;
  status: string;
  probability: number | null;
  healthScore: number | null;
  expectedCloseDate: Date | null;
  lastInteractionAt: Date | null;
  stageEnteredAt: Date;
  position: number;
  accountId: string;
  accountName: string;
  accountIndustry: string | null;
  stageId: string;
  stageName: string;
  stageColor: string | null;
  stagePosition: number;
  ownerId: string | null;
  ownerName: string | null;
  openConcerns: number;
};

function buildPredicates(ctx: Ctx, filters: OpportunityFilters) {
  return scoped(
    ctx,
    opportunities,
    filters.query
      ? or(ilike(opportunities.name, `%${filters.query}%`), ilike(accounts.name, `%${filters.query}%`))
      : undefined,
    filters.status ? eq(opportunities.status, filters.status) : undefined,
    filters.stageId ? eq(opportunities.stageId, filters.stageId) : undefined,
    filters.ownerId ? eq(opportunities.ownerId, filters.ownerId) : undefined,
    filters.accountId ? eq(opportunities.accountId, filters.accountId) : undefined,
    filters.minValue != null ? gte(opportunities.value, filters.minValue) : undefined,
    filters.flag === 'at_risk' ? lte(opportunities.healthScore, 45) : undefined,
    filters.flag === 'quiet'
      ? or(
          isNull(opportunities.lastInteractionAt),
          lt(opportunities.lastInteractionAt, new Date(Date.now() - 14 * 86_400_000)),
        )
      : undefined,
    filters.flag === 'closing_soon'
      ? and(
          eq(opportunities.status, 'open'),
          lte(opportunities.expectedCloseDate, new Date(Date.now() + 30 * 86_400_000)),
          gte(opportunities.expectedCloseDate, new Date()),
        )
      : undefined,
    filters.flag === 'overdue_close'
      ? and(eq(opportunities.status, 'open'), lt(opportunities.expectedCloseDate, new Date()))
      : undefined,
  );
}

export async function listOpportunities(
  ctx: Ctx,
  filters: OpportunityFilters = {},
): Promise<{ rows: OpportunityListRow[]; total: number; totalValue: number }> {
  const limit = Math.min(filters.limit ?? 100, 500);
  const predicates = buildPredicates(ctx, filters);

  const openConcerns = sql<number>`(
    SELECT count(*)::int FROM objections ob
    WHERE ob.opportunity_id = ${opportunities.id} AND ob.status = 'open' AND ob.deleted_at IS NULL
  )`;

  const orderBy = (() => {
    const dir = filters.direction === 'asc' ? asc : desc;
    switch (filters.sort) {
      case 'close':
        return [filters.direction === 'desc' ? desc(opportunities.expectedCloseDate) : asc(opportunities.expectedCloseDate)];
      case 'health':
        return [dir(opportunities.healthScore)];
      case 'activity':
        return [dir(opportunities.lastInteractionAt)];
      case 'name':
        return [filters.direction === 'desc' ? desc(opportunities.name) : asc(opportunities.name)];
      case 'stage':
        return [asc(pipelineStages.position), desc(opportunities.value)];
      case 'value':
      default:
        return [dir(opportunities.value)];
    }
  })();

  const [rows, [totals]] = await Promise.all([
    ctx.db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        value: opportunities.value,
        status: opportunities.status,
        probability: opportunities.probability,
        healthScore: opportunities.healthScore,
        expectedCloseDate: opportunities.expectedCloseDate,
        lastInteractionAt: opportunities.lastInteractionAt,
        stageEnteredAt: opportunities.stageEnteredAt,
        position: opportunities.position,
        accountId: opportunities.accountId,
        accountName: accounts.name,
        accountIndustry: accounts.industry,
        stageId: opportunities.stageId,
        stageName: pipelineStages.name,
        stageColor: pipelineStages.color,
        stagePosition: pipelineStages.position,
        ownerId: opportunities.ownerId,
        ownerName: users.name,
        openConcerns,
      })
      .from(opportunities)
      .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .leftJoin(users, eq(users.id, opportunities.ownerId))
      .where(predicates)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(filters.offset ?? 0),

    ctx.db
      .select({ n: sql<number>`count(*)::int`, sum: sql<number>`COALESCE(SUM(${opportunities.value}), 0)::float8` })
      .from(opportunities)
      .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
      .where(predicates),
  ]);

  return {
    rows: rows.map((r) => ({ ...r, status: r.status as string })),
    total: totals?.n ?? 0,
    totalValue: Number(totals?.sum ?? 0),
  };
}

/** Kanban board: stages plus their deals, ordered by fractional position. */
export async function getPipelineBoard(ctx: Ctx, filters: OpportunityFilters = {}) {
  const [stages, { rows }] = await Promise.all([
    ctx.db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        position: pipelineStages.position,
        probability: pipelineStages.probability,
        type: pipelineStages.type,
        color: pipelineStages.color,
        entryCriteria: pipelineStages.entryCriteria,
      })
      .from(pipelineStages)
      .where(scope(ctx, pipelineStages))
      .orderBy(asc(pipelineStages.position)),
    listOpportunities(ctx, { ...filters, sort: 'value', limit: 500 }),
  ]);

  return stages.map((stage) => {
    const deals = rows
      .filter((r) => r.stageId === stage.id)
      .sort((a, b) => a.position - b.position || b.value - a.value);
    return {
      stage,
      deals,
      count: deals.length,
      value: deals.reduce((sum, d) => sum + d.value, 0),
    };
  });
}

export async function getOpportunityDetail(ctx: Ctx, opportunityId: string) {
  const [row] = await ctx.db
    .select({
      opportunity: opportunities,
      accountName: accounts.name,
      accountIndustry: accounts.industry,
      accountDomain: accounts.domain,
      accountHealth: accounts.healthScore,
      stageName: pipelineStages.name,
      stageColor: pipelineStages.color,
      stagePosition: pipelineStages.position,
      stageCriteria: pipelineStages.entryCriteria,
      pipelineId: opportunities.pipelineId,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(opportunities)
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(users, eq(users.id, opportunities.ownerId))
    .where(and(scope(ctx, opportunities), eq(opportunities.id, opportunityId)))
    .limit(1);

  if (!row) throw new NotFoundError('Opportunity', opportunityId);

  const opp = row.opportunity;

  const [
    stakeholders,
    openCommitments,
    dealObjections,
    signals,
    facts,
    engagement,
    timeline,
    dealEmails,
    dealMeetings,
    dealTasks,
    dealNotes,
    stages,
  ] = await Promise.all([
    ctx.db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        title: contacts.title,
        buyingRole: contacts.buyingRole,
        influence: contacts.influence,
        sentiment: contacts.sentiment,
        lastInteractionAt: contacts.lastInteractionAt,
      })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(contacts.accountId, opp.accountId)))
      .orderBy(desc(contacts.influence)),

    ctx.db
      .select()
      .from(commitments)
      .where(
        scoped(
          ctx,
          commitments,
          eq(commitments.opportunityId, opportunityId),
          inArray(commitments.status, ['open', 'overdue', 'unconfirmed']),
        ),
      )
      .orderBy(asc(commitments.dueAt)),

    ctx.db
      .select()
      .from(objections)
      .where(scoped(ctx, objections, eq(objections.opportunityId, opportunityId)))
      .orderBy(desc(objections.occurredAt)),

    ctx.db
      .select()
      .from(productSignals)
      .where(scoped(ctx, productSignals, eq(productSignals.opportunityId, opportunityId)))
      .orderBy(desc(productSignals.occurredAt)),

    currentFacts(ctx, 'opportunity', opportunityId),
    engagementStats(ctx, { opportunityId }, 90),

    ctx.db
      .select()
      .from(crmEvents)
      .where(scoped(ctx, crmEvents, eq(crmEvents.opportunityId, opportunityId)))
      .orderBy(desc(crmEvents.occurredAt))
      .limit(60),

    ctx.db
      .select({
        id: emails.id,
        subject: emails.subject,
        snippet: emails.bodySnippet,
        direction: emails.direction,
        fromName: emails.fromName,
        fromEmail: emails.fromEmail,
        sentAt: emails.sentAt,
      })
      .from(emails)
      .where(scoped(ctx, emails, eq(emails.opportunityId, opportunityId)))
      .orderBy(desc(emails.sentAt))
      .limit(20),

    ctx.db
      .select({
        id: meetings.id,
        title: meetings.title,
        startsAt: meetings.startsAt,
        status: meetings.status,
        intelligence: meetings.intelligence,
      })
      .from(meetings)
      .where(scoped(ctx, meetings, eq(meetings.opportunityId, opportunityId)))
      .orderBy(desc(meetings.startsAt))
      .limit(20),

    ctx.db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        dueAt: tasks.dueAt,
        assigneeName: users.name,
      })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(scoped(ctx, tasks, eq(tasks.opportunityId, opportunityId)))
      .orderBy(asc(tasks.dueAt))
      .limit(20),

    ctx.db
      .select({ id: notes.id, body: notes.body, createdAt: notes.createdAt, authorName: users.name })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.authorId))
      .where(scoped(ctx, notes, eq(notes.opportunityId, opportunityId)))
      .orderBy(desc(notes.createdAt))
      .limit(10),

    ctx.db
      .select({ id: pipelineStages.id, name: pipelineStages.name, position: pipelineStages.position, type: pipelineStages.type })
      .from(pipelineStages)
      .where(scoped(ctx, pipelineStages, eq(pipelineStages.pipelineId, opp.pipelineId)))
      .orderBy(asc(pipelineStages.position)),
  ]);

  return {
    opportunity: opp,
    account: {
      id: opp.accountId,
      name: row.accountName,
      industry: row.accountIndustry,
      domain: row.accountDomain,
      healthScore: row.accountHealth,
    },
    stage: {
      name: row.stageName,
      color: row.stageColor,
      position: row.stagePosition,
      entryCriteria: row.stageCriteria,
    },
    stages,
    owner: { name: row.ownerName, email: row.ownerEmail },
    stakeholders,
    commitments: openCommitments,
    objections: dealObjections,
    signals,
    facts,
    engagement,
    timeline,
    emails: dealEmails,
    meetings: dealMeetings,
    tasks: dealTasks,
    notes: dealNotes,
  };
}

/* ── Mutations ────────────────────────────────────────────────────────────── */

/**
 * Move a deal on the board.
 *
 * `position` is a fraction placed between its new neighbours, so a drag writes
 * exactly one row instead of renumbering the column — which matters when two
 * people are dragging at once.
 */
export async function moveOpportunity(
  ctx: Ctx,
  input: { opportunityId: string; stageId: string; beforeId?: string; afterId?: string },
): Promise<void> {
  const [opp] = await ctx.db
    .select()
    .from(opportunities)
    .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)))
    .limit(1);
  if (!opp) throw new NotFoundError('Opportunity', input.opportunityId);

  const [stage] = await ctx.db
    .select()
    .from(pipelineStages)
    .where(and(scope(ctx, pipelineStages), eq(pipelineStages.id, input.stageId)))
    .limit(1);
  if (!stage) throw new ValidationError('That pipeline stage does not exist.');

  const neighbours = await ctx.db
    .select({ id: opportunities.id, position: opportunities.position })
    .from(opportunities)
    .where(
      scoped(
        ctx,
        opportunities,
        eq(opportunities.stageId, input.stageId),
        inArray(opportunities.id, [input.beforeId, input.afterId].filter((x): x is string => Boolean(x))),
      ),
    );

  const before = neighbours.find((n) => n.id === input.beforeId)?.position;
  const after = neighbours.find((n) => n.id === input.afterId)?.position;

  let position: number;
  if (before != null && after != null) position = (before + after) / 2;
  else if (before != null) position = before + 1;
  else if (after != null) position = after - 1;
  else {
    const [min] = await ctx.db
      .select({ min: sql<number>`COALESCE(MIN(${opportunities.position}), 0)::float8` })
      .from(opportunities)
      .where(scoped(ctx, opportunities, eq(opportunities.stageId, input.stageId)));
    position = Number(min?.min ?? 0) - 1;
  }

  const stageChanged = opp.stageId !== input.stageId;

  await ctx.db
    .update(opportunities)
    .set({
      stageId: input.stageId,
      position,
      ...(stageChanged
        ? {
            stageEnteredAt: new Date(),
            probability: stage.probability,
            status: stage.type === 'open' ? 'open' : stage.type,
            closedAt: stage.type === 'open' ? null : new Date(),
          }
        : {}),
    })
    .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)));

  if (!stageChanged) return;

  const [fromStage] = await ctx.db
    .select({ name: pipelineStages.name })
    .from(pipelineStages)
    .where(and(scope(ctx, pipelineStages), eq(pipelineStages.id, opp.stageId)))
    .limit(1);

  await record(ctx, {
    action: 'opportunity.stage_changed',
    resourceType: 'opportunity',
    resourceId: opp.id,
    riskLevel: 'medium',
    changes: { stage: { from: fromStage?.name ?? null, to: stage.name } },
  });

  await addTimelineEvent(ctx, {
    type: 'stage_changed',
    subjectType: 'opportunity',
    subjectId: opp.id,
    accountId: opp.accountId,
    opportunityId: opp.id,
    title: `Stage: ${fromStage?.name ?? 'none'} → ${stage.name}`,
    importance: 4,
  });

  await addActivity(ctx, {
    type: 'stage_change',
    subjectType: 'opportunity',
    subjectId: opp.id,
    accountId: opp.accountId,
    opportunityId: opp.id,
    title: `Moved to ${stage.name}`,
    direction: 'internal',
    occurredAt: new Date(),
  });

  // Health depends on stage age and status, so it must be recomputed now
  // rather than waiting for the next scheduled pass.
  const { scoreOpportunityHealth } = await import('../intelligence/health');
  const health = await scoreOpportunityHealth(ctx, opp.id);
  if (health) {
    await ctx.db
      .update(opportunities)
      .set({ healthScore: health.score, healthRationale: health })
      .where(and(scope(ctx, opportunities), eq(opportunities.id, opp.id)));
  }
}

export async function getPipelineFacets(ctx: Ctx) {
  const [stages, owners, pipelineList] = await Promise.all([
    ctx.db
      .select({ id: pipelineStages.id, name: pipelineStages.name, position: pipelineStages.position })
      .from(pipelineStages)
      .where(scope(ctx, pipelineStages))
      .orderBy(asc(pipelineStages.position)),
    ctx.db
      .selectDistinct({ id: users.id, name: users.name })
      .from(opportunities)
      .innerJoin(users, eq(users.id, opportunities.ownerId))
      .where(scope(ctx, opportunities))
      .orderBy(users.name),
    ctx.db
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(scope(ctx, pipelines))
      .orderBy(asc(pipelines.position)),
  ]);
  return { stages, owners, pipelines: pipelineList };
}

/** Headline numbers for the dashboard and the pipeline header. */
export async function getPipelineSummary(ctx: Ctx) {
  const rows = await rawQuery<{
    open_count: number;
    open_value: number;
    weighted_value: number;
    at_risk_value: number;
    closing_30: number;
    won_qtd: number;
    won_value_qtd: number;
  }>(
    ctx,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
        COALESCE(SUM(value) FILTER (WHERE status = 'open'), 0)::float8 AS open_value,
        COALESCE(SUM(value * COALESCE(probability, 0) / 100.0) FILTER (WHERE status = 'open'), 0)::float8 AS weighted_value,
        COALESCE(SUM(value) FILTER (WHERE status = 'open' AND COALESCE(health_score, 100) <= 45), 0)::float8 AS at_risk_value,
        COALESCE(SUM(value) FILTER (
          WHERE status = 'open' AND expected_close_date BETWEEN now() AND now() + interval '30 days'
        ), 0)::float8 AS closing_30,
        COUNT(*) FILTER (WHERE status = 'won' AND closed_at >= date_trunc('quarter', now()))::int AS won_qtd,
        COALESCE(SUM(value) FILTER (WHERE status = 'won' AND closed_at >= date_trunc('quarter', now())), 0)::float8 AS won_value_qtd
      FROM opportunities
      WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL
    `,
  );

  const r = rows[0];
  return {
    openCount: r?.open_count ?? 0,
    openValue: Number(r?.open_value ?? 0),
    weightedValue: Number(r?.weighted_value ?? 0),
    atRiskValue: Number(r?.at_risk_value ?? 0),
    closingThirtyDays: Number(r?.closing_30 ?? 0),
    wonThisQuarter: r?.won_qtd ?? 0,
    wonValueThisQuarter: Number(r?.won_value_qtd ?? 0),
  };
}
