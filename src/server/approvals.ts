import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  agentRunSteps,
  agents,
  approvals,
  notifications,
  type ApprovalPreview,
  type RiskLevel,
  type SourceRef,
} from '@/db/schema';
import { scope, scoped, ValidationError, type Ctx } from './context';
import { ctxAssert } from './context';
import { record } from './audit';

/**
 * Human-in-the-loop approvals.
 *
 * The invariant that makes this trustworthy: **the payload that executes is
 * the payload that was shown.** On approval the executor re-reads `payload`
 * (or `editedPayload`, if the approver changed it) from this row and dispatches
 * it with `preApproved: true`. The model is not consulted again, so it cannot
 * substitute different arguments between approval and execution.
 */

export type CreateApprovalInput = {
  tool: string;
  riskLevel: RiskLevel;
  title: string;
  rationale?: string;
  payload: Record<string, unknown>;
  preview: ApprovalPreview;
  sources?: SourceRef[];
  runId?: string;
  stepId?: string;
  agentId?: string;
  automationRunId?: string;
  requestedForId?: string | null;
  expiresAfterHours?: number;
};

export async function createApproval(ctx: Ctx, input: CreateApprovalInput) {
  const [approval] = await ctx.db
    .insert(approvals)
    .values({
      workspaceId: ctx.workspaceId,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      agentId: input.agentId ?? null,
      automationRunId: input.automationRunId ?? null,
      tool: input.tool,
      riskLevel: input.riskLevel,
      title: input.title,
      rationale: input.rationale ?? null,
      payload: input.payload,
      preview: input.preview,
      sources: input.sources ?? [],
      status: 'pending',
      requestedForId: input.requestedForId ?? null,
      expiresAt: new Date(Date.now() + (input.expiresAfterHours ?? 48) * 3_600_000),
    })
    .returning();

  await ctx.db
    .insert(notifications)
    .values({
      workspaceId: ctx.workspaceId,
      userId: input.requestedForId ?? null,
      kind: 'agent_approval',
      title: input.title,
      whatHappened: `${ctx.actor.label} proposed an action that needs your approval.`,
      whyItMatters:
        input.riskLevel === 'high'
          ? 'This action is externally visible or irreversible, so it will not run until you approve it.'
          : 'This changes CRM data, so it is held for review.',
      recommendedAction: { label: 'Review', kind: 'open_approval', payload: { approvalId: approval!.id } },
      severity: input.riskLevel === 'high' ? 'warning' : 'info',
      approvalId: approval!.id,
      runId: input.runId ?? null,
      dedupeKey: `approval:${approval!.id}`,
    })
    .onConflictDoNothing();

  await record(ctx, {
    action: 'approval.requested',
    resourceType: 'approval',
    resourceId: approval!.id,
    riskLevel: input.riskLevel,
    approvalId: approval!.id,
    metadata: { tool: input.tool, title: input.title },
  });

  return approval!;
}

export type DecideInput = {
  approvalId: string;
  decision: 'approve' | 'reject';
  note?: string;
  /** Approver edits — e.g. rewording an email before it goes out. */
  editedPayload?: Record<string, unknown>;
};

export type DecideResult = {
  approval: typeof approvals.$inferSelect;
  executed: boolean;
  result?: unknown;
  error?: string;
};

export async function decideApproval(ctx: Ctx, input: DecideInput): Promise<DecideResult> {
  const [approval] = await ctx.db
    .select()
    .from(approvals)
    .where(and(scope(ctx, approvals), eq(approvals.id, input.approvalId)))
    .limit(1);

  if (!approval) throw new ValidationError('That approval no longer exists.');
  if (approval.status !== 'pending') {
    throw new ValidationError(`This request was already ${approval.status}.`);
  }
  if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
    await ctx.db.update(approvals).set({ status: 'expired' }).where(eq(approvals.id, approval.id));
    throw new ValidationError('This request expired before it was decided.');
  }

  // The permission to approve scales with the risk being approved.
  ctxAssert(
    ctx,
    approval.riskLevel === 'high'
      ? 'ai:approve_high'
      : approval.riskLevel === 'medium'
        ? 'ai:approve_medium'
        : 'ai:approve_low',
  );

  if (input.decision === 'reject') {
    const [updated] = await ctx.db
      .update(approvals)
      .set({
        status: 'rejected',
        decidedById: ctx.userId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(eq(approvals.id, approval.id))
      .returning();

    await resolveNotification(ctx, approval.id);
    if (approval.stepId) {
      await ctx.db
        .update(agentRunSteps)
        .set({ status: 'denied', error: input.note ?? 'Rejected by approver.' })
        .where(eq(agentRunSteps.id, approval.stepId));
    }

    await record(ctx, {
      action: 'approval.rejected',
      resourceType: 'approval',
      resourceId: approval.id,
      riskLevel: approval.riskLevel,
      approvalId: approval.id,
      metadata: { tool: approval.tool, note: input.note },
    });

    return { approval: updated!, executed: false };
  }

  /* Approved — execute the stored payload, not anything supplied now. */
  const payload = input.editedPayload ?? approval.payload;

  const [approvedRow] = await ctx.db
    .update(approvals)
    .set({
      status: 'approved',
      decidedById: ctx.userId,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
      editedPayload: input.editedPayload ?? null,
    })
    .where(eq(approvals.id, approval.id))
    .returning();

  await record(ctx, {
    action: 'approval.approved',
    resourceType: 'approval',
    resourceId: approval.id,
    riskLevel: approval.riskLevel,
    approvalId: approval.id,
    metadata: { tool: approval.tool, edited: Boolean(input.editedPayload) },
  });

  const { dispatchTool, ensureToolsLoaded } = await import('@/lib/agents/dispatch');
  await ensureToolsLoaded();

  // Execute as the approver: the human who clicked is the authority for the
  // action, and the audit trail records both them and the originating agent.
  const outcome = await dispatchTool(
    { ...ctx, approvalId: approval.id, runId: approval.runId ?? undefined },
    approval.tool,
    payload,
    { preApproved: true, agentId: approval.agentId ?? undefined, runId: approval.runId ?? undefined },
  );

  if (outcome.status === 'ok') {
    const [executed] = await ctx.db
      .update(approvals)
      .set({
        status: 'executed',
        executedAt: new Date(),
        executionResult: { summary: outcome.result.summary, data: outcome.result.data } as Record<string, unknown>,
      })
      .where(eq(approvals.id, approval.id))
      .returning();

    if (approval.stepId) {
      await ctx.db
        .update(agentRunSteps)
        .set({ status: 'ok', output: outcome.result.data as never })
        .where(eq(agentRunSteps.id, approval.stepId));
    }

    await resolveNotification(ctx, approval.id);
    await record(ctx, {
      action: 'approval.executed',
      resourceType: 'approval',
      resourceId: approval.id,
      riskLevel: approval.riskLevel,
      approvalId: approval.id,
      metadata: { tool: approval.tool, summary: outcome.result.summary },
    });

    return { approval: executed!, executed: true, result: outcome.result };
  }

  const errorMessage = outcome.status === 'error' ? outcome.error : 'Execution stalled awaiting a further approval.';

  await ctx.db
    .update(approvals)
    .set({ executionResult: { error: errorMessage } })
    .where(eq(approvals.id, approval.id));

  return { approval: approvedRow!, executed: false, error: errorMessage };
}

async function resolveNotification(ctx: Ctx, approvalId: string): Promise<void> {
  await ctx.db
    .update(notifications)
    .set({ resolvedAt: new Date() })
    .where(and(scope(ctx, notifications), eq(notifications.approvalId, approvalId)));
}

export async function listPendingApprovals(ctx: Ctx, limit = 50) {
  return ctx.db
    .select()
    .from(approvals)
    .where(scoped(ctx, approvals, eq(approvals.status, 'pending')))
    .orderBy(desc(approvals.createdAt))
    .limit(limit);
}

export async function getApproval(ctx: Ctx, approvalId: string) {
  const [row] = await ctx.db
    .select()
    .from(approvals)
    .where(and(scope(ctx, approvals), eq(approvals.id, approvalId)))
    .limit(1);
  return row ?? null;
}

/** Sweep expired requests so nothing fires days after it was proposed. */
export async function expireStaleApprovals(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(scope(ctx, approvals), eq(approvals.status, 'pending'), lt(approvals.expiresAt, new Date())))
    .returning({ id: approvals.id });

  for (const row of rows) await resolveNotification(ctx, row.id);
  return rows.length;
}
