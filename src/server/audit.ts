import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { auditEvents } from '@/db/schema';
import type { RiskLevel } from '@/db/schema';
import type { Ctx } from './context';
import { scoped } from './context';

/**
 * Append-only audit trail.
 *
 * This module exposes `record()` and readers — and no update or delete. That is
 * intentional: the audit log is the record of what agents were allowed to do,
 * so it must not be rewritable by the same code paths that take the actions.
 */

export type AuditInput = {
  action: string;
  resourceType?: string;
  resourceId?: string;
  riskLevel?: RiskLevel;
  changes?: Record<string, { from: unknown; to: unknown }>;
  metadata?: Record<string, unknown>;
  approvalId?: string;
};

export async function record(ctx: Ctx, input: AuditInput): Promise<void> {
  try {
    await ctx.db.insert(auditEvents).values({
      workspaceId: ctx.workspaceId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      actorLabel: ctx.actor.label,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      riskLevel: input.riskLevel ?? null,
      changes: input.changes ?? null,
      metadata: input.metadata ?? null,
      runId: ctx.runId ?? null,
      approvalId: input.approvalId ?? ctx.approvalId ?? null,
      ipHash: ctx.request?.ipHash ?? null,
      userAgent: ctx.request?.userAgent ?? null,
      occurredAt: new Date(),
    });
  } catch (err) {
    // An audit write must never take down the action it describes, but a
    // silent failure would be worse than noisy logs.
    console.error('[audit] failed to record event', input.action, err);
  }
}

/** Diff two records down to the fields that actually changed. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: string[],
): Record<string, { from: unknown; to: unknown }> {
  const keys = fields ?? Object.keys(after);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (to === undefined) continue;
    const same =
      from instanceof Date && to instanceof Date
        ? from.getTime() === to.getTime()
        : JSON.stringify(from ?? null) === JSON.stringify(to ?? null);
    if (!same) changes[key] = { from: from ?? null, to };
  }
  return changes;
}

export async function listAuditEvents(
  ctx: Ctx,
  options: {
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  } = {},
) {
  return ctx.db
    .select()
    .from(auditEvents)
    .where(
      scoped(
        ctx,
        auditEvents,
        options.resourceType ? eq(auditEvents.resourceType, options.resourceType) : undefined,
        options.resourceId ? eq(auditEvents.resourceId, options.resourceId) : undefined,
        options.actorId ? eq(auditEvents.actorId, options.actorId) : undefined,
        options.from ? gte(auditEvents.occurredAt, options.from) : undefined,
        options.to ? lte(auditEvents.occurredAt, options.to) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(Math.min(options.limit ?? 100, 500));
}
