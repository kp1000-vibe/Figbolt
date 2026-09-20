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
  productSignals,
  relationships,
  tasks,
  users,
} from '@/db/schema';
import { scope, scoped, NotFoundError, type Ctx } from '../context';
import { rawQuery } from '../db-query';
import { currentFacts, changedFacts } from '../memory/facts';
import { engagementStats } from '../memory/timeline';

/** Read models for the account list and detail pages. */

export type AccountFilters = {
  query?: string;
  industry?: string;
  lifecycleStage?: string;
  ownerId?: string;
  tier?: string;
  /** 'at_risk' | 'quiet' | 'no_champion' — saved-view style shortcuts. */
  flag?: string;
  sort?: 'name' | 'health' | 'arr' | 'activity' | 'pipeline';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

export type AccountListRow = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  currentArr: number | null;
  lifecycleStage: string;
  tier: string | null;
  healthScore: number | null;
  sentiment: number | null;
  engagementTrend: string | null;
  lastInteractionAt: Date | null;
  ownerName: string | null;
  openDeals: number;
  openPipeline: number;
  openConcerns: number;
};

export async function listAccounts(
  ctx: Ctx,
  filters: AccountFilters = {},
): Promise<{ rows: AccountListRow[]; total: number }> {
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const predicates = scoped(
    ctx,
    accounts,
    filters.query
      ? or(ilike(accounts.name, `%${filters.query}%`), ilike(accounts.domain, `%${filters.query}%`))
      : undefined,
    filters.industry ? eq(accounts.industry, filters.industry) : undefined,
    filters.lifecycleStage ? eq(accounts.lifecycleStage, filters.lifecycleStage as never) : undefined,
    filters.ownerId ? eq(accounts.ownerId, filters.ownerId) : undefined,
    filters.tier ? eq(accounts.tier, filters.tier as never) : undefined,
    filters.flag === 'at_risk' ? lte(accounts.healthScore, 45) : undefined,
    filters.flag === 'quiet'
      ? or(
          isNull(accounts.lastInteractionAt),
          lt(accounts.lastInteractionAt, new Date(Date.now() - 30 * 86_400_000)),
        )
      : undefined,
  );

  // Aggregates come from correlated subqueries rather than joins: a join on
  // opportunities would multiply account rows and break the LIMIT.
  const openDeals = sql<number>`(
    SELECT count(*)::int FROM opportunities o
    WHERE o.account_id = ${accounts.id} AND o.status = 'open' AND o.deleted_at IS NULL
  )`;
  const openPipeline = sql<number>`(
    SELECT COALESCE(SUM(o.value), 0)::float8 FROM opportunities o
    WHERE o.account_id = ${accounts.id} AND o.status = 'open' AND o.deleted_at IS NULL
  )`;
  const openConcerns = sql<number>`(
    SELECT count(*)::int FROM objections ob
    WHERE ob.account_id = ${accounts.id} AND ob.status = 'open' AND ob.deleted_at IS NULL
  )`;

  const orderBy = (() => {
    const dir = filters.direction === 'asc' ? asc : desc;
    switch (filters.sort) {
      case 'health':
        return [dir(accounts.healthScore), asc(accounts.name)];
      case 'arr':
        return [dir(accounts.currentArr), asc(accounts.name)];
      case 'activity':
        return [dir(accounts.lastInteractionAt), asc(accounts.name)];
      case 'pipeline':
        return [filters.direction === 'asc' ? asc(openPipeline) : desc(openPipeline), asc(accounts.name)];
      case 'name':
      default:
        return [filters.direction === 'desc' ? desc(accounts.name) : asc(accounts.name)];
    }
  })();

  const [rows, [countRow]] = await Promise.all([
    ctx.db
      .select({
        id: accounts.id,
        name: accounts.name,
        domain: accounts.domain,
        industry: accounts.industry,
        employeeCount: accounts.employeeCount,
        currentArr: accounts.currentArr,
        lifecycleStage: accounts.lifecycleStage,
        tier: accounts.tier,
        healthScore: accounts.healthScore,
        sentiment: accounts.sentiment,
        engagementTrend: accounts.engagementTrend,
        lastInteractionAt: accounts.lastInteractionAt,
        ownerName: users.name,
        openDeals,
        openPipeline,
        openConcerns,
      })
      .from(accounts)
      .leftJoin(users, eq(users.id, accounts.ownerId))
      .where(predicates)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(accounts).where(predicates),
  ]);

  return {
    rows: rows.map((r) => ({
      ...r,
      openPipeline: Number(r.openPipeline),
      lifecycleStage: r.lifecycleStage as string,
    })),
    total: countRow?.n ?? 0,
  };
}

export async function getAccountDetail(ctx: Ctx, accountId: string) {
  const [account] = await ctx.db
    .select({
      account: accounts,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(accounts)
    .leftJoin(users, eq(users.id, accounts.ownerId))
    .where(and(scope(ctx, accounts), eq(accounts.id, accountId)))
    .limit(1);

  if (!account) throw new NotFoundError('Account', accountId);

  const [
    people,
    deals,
    openCommitments,
    openObjections,
    signals,
    facts,
    changed,
    engagement,
    recentEmails,
    recentMeetings,
    accountNotes,
    openTasks,
  ] = await Promise.all([
    ctx.db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        title: contacts.title,
        seniority: contacts.seniority,
        buyingRole: contacts.buyingRole,
        influence: contacts.influence,
        sentiment: contacts.sentiment,
        lastInteractionAt: contacts.lastInteractionAt,
        isPrimary: contacts.isPrimary,
      })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(contacts.accountId, accountId)))
      .orderBy(desc(contacts.isPrimary), desc(contacts.influence)),

    ctx.db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        value: opportunities.value,
        status: opportunities.status,
        healthScore: opportunities.healthScore,
        expectedCloseDate: opportunities.expectedCloseDate,
        stageName: pipelineStages.name,
        stageColor: pipelineStages.color,
        lastInteractionAt: opportunities.lastInteractionAt,
      })
      .from(opportunities)
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(scoped(ctx, opportunities, eq(opportunities.accountId, accountId)))
      .orderBy(desc(opportunities.status), desc(opportunities.value)),

    ctx.db
      .select()
      .from(commitments)
      .where(
        scoped(
          ctx,
          commitments,
          eq(commitments.accountId, accountId),
          inArray(commitments.status, ['open', 'overdue', 'unconfirmed']),
        ),
      )
      .orderBy(asc(commitments.dueAt)),

    ctx.db
      .select()
      .from(objections)
      .where(scoped(ctx, objections, eq(objections.accountId, accountId), inArray(objections.status, ['open', 'addressed'])))
      .orderBy(desc(objections.occurredAt)),

    ctx.db
      .select()
      .from(productSignals)
      .where(scoped(ctx, productSignals, eq(productSignals.accountId, accountId)))
      .orderBy(desc(productSignals.occurredAt))
      .limit(25),

    currentFacts(ctx, 'account', accountId),
    changedFacts(ctx, 'account', accountId),
    engagementStats(ctx, { accountId }, 90),

    ctx.db
      .select({
        id: emails.id,
        subject: emails.subject,
        snippet: emails.bodySnippet,
        direction: emails.direction,
        fromName: emails.fromName,
        fromEmail: emails.fromEmail,
        sentAt: emails.sentAt,
        sentiment: emails.sentiment,
      })
      .from(emails)
      .where(scoped(ctx, emails, eq(emails.accountId, accountId)))
      .orderBy(desc(emails.sentAt))
      .limit(25),

    ctx.db
      .select({
        id: meetings.id,
        title: meetings.title,
        startsAt: meetings.startsAt,
        status: meetings.status,
        intelligence: meetings.intelligence,
        sentiment: meetings.sentiment,
      })
      .from(meetings)
      .where(scoped(ctx, meetings, eq(meetings.accountId, accountId)))
      .orderBy(desc(meetings.startsAt))
      .limit(20),

    ctx.db
      .select({
        id: notes.id,
        body: notes.body,
        createdAt: notes.createdAt,
        authorName: users.name,
        pinned: notes.pinned,
      })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.authorId))
      .where(scoped(ctx, notes, eq(notes.accountId, accountId)))
      .orderBy(desc(notes.pinned), desc(notes.createdAt))
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
      .where(scoped(ctx, tasks, eq(tasks.accountId, accountId), inArray(tasks.status, ['open', 'in_progress'])))
      .orderBy(asc(tasks.dueAt))
      .limit(20),
  ]);

  return {
    account: account.account,
    ownerName: account.ownerName,
    ownerEmail: account.ownerEmail,
    contacts: people,
    opportunities: deals,
    commitments: openCommitments,
    objections: openObjections,
    signals,
    facts,
    changedFactKeys: changed,
    engagement,
    emails: recentEmails,
    meetings: recentMeetings,
    notes: accountNotes,
    tasks: openTasks,
  };
}

/** Full timeline for the Timeline tab. */
export async function getAccountTimeline(
  ctx: Ctx,
  accountId: string,
  options: { minImportance?: number; limit?: number } = {},
) {
  return ctx.db
    .select()
    .from(crmEvents)
    .where(
      scoped(
        ctx,
        crmEvents,
        eq(crmEvents.accountId, accountId),
        options.minImportance ? gte(crmEvents.importance, options.minImportance) : undefined,
      ),
    )
    .orderBy(desc(crmEvents.occurredAt))
    .limit(options.limit ?? 150);
}

/**
 * Relationship graph for an account: internal owners, customer contacts, deals
 * and the typed edges between them.
 */
export async function getRelationshipGraph(ctx: Ctx, accountId: string) {
  const [people, deals, edges, [account]] = await Promise.all([
    ctx.db
      .select({
        id: contacts.id,
        name: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`,
        title: contacts.title,
        buyingRole: contacts.buyingRole,
        influence: contacts.influence,
        seniority: contacts.seniority,
      })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(contacts.accountId, accountId))),
    ctx.db
      .select({ id: opportunities.id, name: opportunities.name, value: opportunities.value, status: opportunities.status })
      .from(opportunities)
      .where(scoped(ctx, opportunities, eq(opportunities.accountId, accountId))),
    ctx.db
      .select()
      .from(relationships)
      .where(scope(ctx, relationships)),
    ctx.db
      .select({ id: accounts.id, name: accounts.name, ownerId: accounts.ownerId })
      .from(accounts)
      .where(and(scope(ctx, accounts), eq(accounts.id, accountId)))
      .limit(1),
  ]);

  const contactIds = new Set(people.map((p) => p.id));
  const dealIds = new Set(deals.map((d) => d.id));

  // Keep only edges where both ends are on this account's canvas.
  const relevant = edges.filter((e) => {
    const fromOk =
      (e.fromType === 'contact' && contactIds.has(e.fromId)) ||
      (e.fromType === 'opportunity' && dealIds.has(e.fromId)) ||
      (e.fromType === 'account' && e.fromId === accountId);
    const toOk =
      (e.toType === 'contact' && contactIds.has(e.toId)) ||
      (e.toType === 'opportunity' && dealIds.has(e.toId)) ||
      (e.toType === 'account' && e.toId === accountId);
    return fromOk && toOk;
  });

  return { account: account ?? null, contacts: people, opportunities: deals, edges: relevant };
}

/** Distinct filter values, for the list page's dropdowns. */
export async function getAccountFacets(ctx: Ctx) {
  const [industries, owners] = await Promise.all([
    rawQuery<{ value: string; n: number }>(
      ctx,
      sql`SELECT industry AS value, count(*)::int AS n
          FROM accounts
          WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL AND industry IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
    ),
    ctx.db
      .selectDistinct({ id: users.id, name: users.name })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.ownerId))
      .where(scope(ctx, accounts))
      .orderBy(users.name),
  ]);
  return { industries, owners };
}
