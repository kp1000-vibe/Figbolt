import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { accounts, commitments, contacts, opportunities, tasks, users } from '@/db/schema';
import { NotFoundError, scope, scoped, type Ctx } from '../context';
import { ctxAssert } from '../context';
import { record } from '../audit';
import { addTimelineEvent } from '../memory/timeline';

export type TaskFilters = {
  status?: 'open' | 'in_progress' | 'completed' | 'cancelled';
  assigneeId?: string;
  /** 'overdue' | 'today' | 'week' | 'unassigned' */
  bucket?: string;
  query?: string;
  accountId?: string;
  opportunityId?: string;
  limit?: number;
};

export async function listTasks(ctx: Ctx, filters: TaskFilters = {}) {
  const startOfTomorrow = new Date();
  startOfTomorrow.setHours(24, 0, 0, 0);
  const weekOut = new Date(Date.now() + 7 * 86_400_000);

  return ctx.db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      dueAt: tasks.dueAt,
      completedAt: tasks.completedAt,
      createdAt: tasks.createdAt,
      assigneeId: tasks.assigneeId,
      assigneeName: users.name,
      accountId: tasks.accountId,
      accountName: accounts.name,
      opportunityId: tasks.opportunityId,
      opportunityName: opportunities.name,
      createdByAgentId: tasks.createdByAgentId,
      sourceType: tasks.sourceType,
      sourceId: tasks.sourceId,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .leftJoin(accounts, eq(accounts.id, tasks.accountId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .where(
      scoped(
        ctx,
        tasks,
        filters.status ? eq(tasks.status, filters.status) : undefined,
        filters.assigneeId ? eq(tasks.assigneeId, filters.assigneeId) : undefined,
        filters.accountId ? eq(tasks.accountId, filters.accountId) : undefined,
        filters.opportunityId ? eq(tasks.opportunityId, filters.opportunityId) : undefined,
        filters.query ? ilike(tasks.title, `%${filters.query}%`) : undefined,
        filters.bucket === 'overdue'
          ? and(inArray(tasks.status, ['open', 'in_progress']), lt(tasks.dueAt, new Date()))
          : undefined,
        filters.bucket === 'today'
          ? and(inArray(tasks.status, ['open', 'in_progress']), lt(tasks.dueAt, startOfTomorrow))
          : undefined,
        filters.bucket === 'week'
          ? and(inArray(tasks.status, ['open', 'in_progress']), lte(tasks.dueAt, weekOut))
          : undefined,
        filters.bucket === 'unassigned' ? isNull(tasks.assigneeId) : undefined,
      ),
    )
    // Nulls last: an undated task should not float above one due today.
    .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, desc(tasks.priority))
    .limit(filters.limit ?? 200);
}

export async function countOpenTasks(ctx: Ctx, userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      scoped(
        ctx,
        tasks,
        inArray(tasks.status, ['open', 'in_progress']),
        or(eq(tasks.assigneeId, userId), isNull(tasks.assigneeId)),
        lte(tasks.dueAt, new Date(Date.now() + 86_400_000)),
      ),
    );
  return row?.n ?? 0;
}

export async function taskCounts(ctx: Ctx, userId?: string) {
  const mine = userId ? or(eq(tasks.assigneeId, userId), isNull(tasks.assigneeId)) : undefined;
  const startOfTomorrow = new Date();
  startOfTomorrow.setHours(24, 0, 0, 0);

  const [row] = await ctx.db
    .select({
      open: sql<number>`count(*) FILTER (WHERE ${tasks.status} IN ('open','in_progress'))::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${tasks.status} IN ('open','in_progress') AND ${tasks.dueAt} < now())::int`,
      today: sql<number>`count(*) FILTER (WHERE ${tasks.status} IN ('open','in_progress') AND ${tasks.dueAt} < ${startOfTomorrow})::int`,
      completed: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'completed')::int`,
      unassigned: sql<number>`count(*) FILTER (WHERE ${tasks.assigneeId} IS NULL AND ${tasks.status} IN ('open','in_progress'))::int`,
    })
    .from(tasks)
    .where(scoped(ctx, tasks, mine));

  return {
    open: row?.open ?? 0,
    overdue: row?.overdue ?? 0,
    today: row?.today ?? 0,
    completed: row?.completed ?? 0,
    unassigned: row?.unassigned ?? 0,
  };
}

export type CreateTaskInput = {
  title: string;
  description?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  dueAt?: Date | null;
  assigneeId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  commitmentId?: string | null;
};

export async function createTask(ctx: Ctx, input: CreateTaskInput) {
  ctxAssert(ctx, 'record:create');

  const [task] = await ctx.db
    .insert(tasks)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 'normal',
      dueAt: input.dueAt ?? null,
      assigneeId: input.assigneeId ?? ctx.userId,
      createdById: ctx.userId,
      createdByAgentId: ctx.actor.type === 'agent' ? ctx.actor.id : null,
      accountId: input.accountId ?? null,
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      sourceType: input.commitmentId ? 'commitment' : null,
      sourceId: input.commitmentId ?? null,
    })
    .returning();

  // Linking both ways makes "is this promise handled?" answerable from either side.
  if (input.commitmentId) {
    await ctx.db
      .update(commitments)
      .set({ taskId: task!.id })
      .where(and(scope(ctx, commitments), eq(commitments.id, input.commitmentId)));
  }

  await record(ctx, {
    action: 'task.created',
    resourceType: 'task',
    resourceId: task!.id,
    riskLevel: 'medium',
    metadata: { title: input.title },
  });

  return task!;
}

export async function setTaskStatus(
  ctx: Ctx,
  taskId: string,
  status: 'open' | 'in_progress' | 'completed' | 'cancelled',
) {
  ctxAssert(ctx, 'record:update');

  const [existing] = await ctx.db
    .select()
    .from(tasks)
    .where(and(scope(ctx, tasks), eq(tasks.id, taskId)))
    .limit(1);
  if (!existing) throw new NotFoundError('Task', taskId);

  await ctx.db
    .update(tasks)
    .set({ status, completedAt: status === 'completed' ? new Date() : null })
    .where(and(scope(ctx, tasks), eq(tasks.id, taskId)));

  // Completing a task that fulfils a commitment closes the commitment too —
  // otherwise the Inbox keeps nagging about work that is demonstrably done.
  if (status === 'completed' && existing.sourceType === 'commitment' && existing.sourceId) {
    await ctx.db
      .update(commitments)
      .set({ status: 'fulfilled', fulfilledAt: new Date() })
      .where(and(scope(ctx, commitments), eq(commitments.id, existing.sourceId)));

    if (existing.accountId) {
      await addTimelineEvent(ctx, {
        type: 'commitment_fulfilled',
        subjectType: 'account',
        subjectId: existing.accountId,
        accountId: existing.accountId,
        opportunityId: existing.opportunityId,
        title: `Commitment fulfilled: ${existing.title}`,
        importance: 3,
      });
    }
  }

  if (status === 'completed' && existing.accountId) {
    await addTimelineEvent(ctx, {
      type: 'task_completed',
      subjectType: 'account',
      subjectId: existing.accountId,
      accountId: existing.accountId,
      opportunityId: existing.opportunityId,
      title: `Task completed: ${existing.title}`,
    });
  }

  await record(ctx, {
    action: 'task.status_changed',
    resourceType: 'task',
    resourceId: taskId,
    riskLevel: 'medium',
    changes: { status: { from: existing.status, to: status } },
  });
}

/* ── Commitments ──────────────────────────────────────────────────────────── */

export type CommitmentFilters = {
  direction?: 'we_owe' | 'they_owe';
  status?: string;
  bucket?: 'overdue' | 'due_soon' | 'open';
  accountId?: string;
  limit?: number;
};

export async function listCommitments(ctx: Ctx, filters: CommitmentFilters = {}) {
  return ctx.db
    .select({
      id: commitments.id,
      description: commitments.description,
      direction: commitments.direction,
      ownerLabel: commitments.ownerLabel,
      dueAt: commitments.dueAt,
      status: commitments.status,
      confidence: commitments.confidence,
      sourceType: commitments.sourceType,
      sourceId: commitments.sourceId,
      sourceQuote: commitments.sourceQuote,
      sourceSegmentIndex: commitments.sourceSegmentIndex,
      taskId: commitments.taskId,
      accountId: commitments.accountId,
      accountName: accounts.name,
      opportunityId: commitments.opportunityId,
      opportunityName: opportunities.name,
      createdAt: commitments.createdAt,
    })
    .from(commitments)
    .leftJoin(accounts, eq(accounts.id, commitments.accountId))
    .leftJoin(opportunities, eq(opportunities.id, commitments.opportunityId))
    .where(
      scoped(
        ctx,
        commitments,
        filters.direction ? eq(commitments.direction, filters.direction) : undefined,
        filters.status ? eq(commitments.status, filters.status as never) : undefined,
        filters.accountId ? eq(commitments.accountId, filters.accountId) : undefined,
        filters.bucket === 'overdue'
          ? and(inArray(commitments.status, ['open', 'overdue']), lt(commitments.dueAt, new Date()))
          : undefined,
        filters.bucket === 'due_soon'
          ? and(
              eq(commitments.status, 'open'),
              gte(commitments.dueAt, new Date()),
              lte(commitments.dueAt, new Date(Date.now() + 7 * 86_400_000)),
            )
          : undefined,
        filters.bucket === 'open' ? inArray(commitments.status, ['open', 'overdue', 'unconfirmed']) : undefined,
      ),
    )
    .orderBy(sql`${commitments.dueAt} ASC NULLS LAST`)
    .limit(filters.limit ?? 100);
}

export async function setCommitmentStatus(
  ctx: Ctx,
  commitmentId: string,
  status: 'open' | 'fulfilled' | 'cancelled',
) {
  ctxAssert(ctx, 'record:update');

  const [existing] = await ctx.db
    .select()
    .from(commitments)
    .where(and(scope(ctx, commitments), eq(commitments.id, commitmentId)))
    .limit(1);
  if (!existing) throw new NotFoundError('Commitment', commitmentId);

  await ctx.db
    .update(commitments)
    .set({ status, fulfilledAt: status === 'fulfilled' ? new Date() : null })
    .where(and(scope(ctx, commitments), eq(commitments.id, commitmentId)));

  await record(ctx, {
    action: 'commitment.status_changed',
    resourceType: 'commitment',
    resourceId: commitmentId,
    riskLevel: 'medium',
    changes: { status: { from: existing.status, to: status } },
  });
}
