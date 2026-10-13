import { eq } from 'drizzle-orm';
import { workspaces, type ApprovalPreview, type RiskLevel } from '@/db/schema';
import { AuthorizationError, can } from '@/lib/security/permissions';
import type { Ctx } from '@/server/context';
import { ValidationError } from '@/server/context';
import { record } from '@/server/audit';
import { getTool, type ToolResult } from './registry';

/**
 * The single chokepoint between a model's output and any real effect.
 *
 * Nothing in the product calls a tool's `execute` directly — Ask AI, agent
 * runs, and automations all come through here, so the same five checks apply
 * to every path:
 *
 *   allow-list → permission → validation → risk/approval → execute + audit
 *
 * Ordering matters. Permission is checked *before* validation so a caller
 * without rights learns nothing about the schema, and the approval decision
 * happens *after* validation so an approver is never shown a payload that
 * would have failed anyway.
 */

export type DispatchOutcome =
  | { status: 'ok'; result: ToolResult; riskLevel: RiskLevel }
  | { status: 'needs_approval'; approvalId: string; preview: ApprovalPreview; riskLevel: RiskLevel; title: string }
  | { status: 'error'; error: string; code: string; riskLevel: RiskLevel };

export type DispatchOptions = {
  /** Tools this caller may use. Omitted means "every registered tool". */
  allowList?: string[];
  /** Risk levels that may run unattended for this caller. */
  autoApprove?: RiskLevel[];
  agentId?: string;
  runId?: string;
  stepId?: string;
  /** Who should decide, if approval is needed. */
  requestedForId?: string | null;
  rationale?: string;
  /** Skip approval because a human already approved this exact payload. */
  preApproved?: boolean;
  /**
   * This call is one tool, invoked directly by a human who was shown the
   * payload and clicked. Opt-in per call site — see `mayAutoRun`.
   */
  directUserAction?: boolean;
  approvalExpiryHours?: number;
};

export async function dispatchTool(
  ctx: Ctx,
  toolName: string,
  rawInput: unknown,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const tool = getTool(toolName);

  /* 1 — allow-list */
  if (!tool) {
    return { status: 'error', error: `Unknown tool "${toolName}".`, code: 'UNKNOWN_TOOL', riskLevel: 'low' };
  }
  if (options.allowList && !options.allowList.includes(toolName)) {
    // A model asking for a tool outside its configured set is a signal worth
    // recording, not just a silent refusal.
    await record(ctx, {
      action: 'agent.tool_denied',
      resourceType: 'tool',
      resourceId: toolName,
      riskLevel: tool.risk,
      metadata: { reason: 'not_in_allow_list', agentId: options.agentId },
    });
    return {
      status: 'error',
      error: `Tool "${toolName}" is not enabled for this agent.`,
      code: 'TOOL_NOT_ALLOWED',
      riskLevel: tool.risk,
    };
  }

  /* 2 — permission, against the effective (possibly clamped) role */
  if (!can(ctx.role, tool.permission)) {
    await record(ctx, {
      action: 'agent.tool_denied',
      resourceType: 'tool',
      resourceId: toolName,
      riskLevel: tool.risk,
      metadata: { reason: 'insufficient_permission', required: tool.permission, role: ctx.role },
    });
    return {
      status: 'error',
      error: `Not permitted: "${toolName}" requires ${tool.permission}, and this actor has role "${ctx.role}".`,
      code: 'FORBIDDEN',
      riskLevel: tool.risk,
    };
  }

  /* 3 — validation */
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .slice(0, 5)
      .join('; ');
    return {
      status: 'error',
      error: `Invalid arguments for ${toolName} — ${issues}`,
      code: 'INVALID_INPUT',
      riskLevel: tool.risk,
    };
  }
  const input = parsed.data;

  /* 4 — risk gate */
  const humanOnly = tool.neverAutoRun === true && !(options.directUserAction && ctx.actor.type === 'user');
  const needsApproval =
    !tool.readOnly && !options.preApproved && (humanOnly || !(await mayAutoRun(ctx, tool.risk, options)));

  if (needsApproval) {
    if (!tool.preview) {
      return {
        status: 'error',
        error: `Tool "${toolName}" requires approval but cannot render a preview.`,
        code: 'NO_PREVIEW',
        riskLevel: tool.risk,
      };
    }

    let preview: ApprovalPreview;
    try {
      preview = await tool.preview({ ctx, agentId: options.agentId, runId: options.runId }, input);
    } catch (err) {
      return {
        status: 'error',
        error: describeError(err),
        code: err instanceof ValidationError ? 'VALIDATION' : 'PREVIEW_FAILED',
        riskLevel: tool.risk,
      };
    }

    const { createApproval } = await import('@/server/approvals');
    const title = titleFor(toolName, preview);
    const approval = await createApproval(ctx, {
      tool: toolName,
      riskLevel: tool.risk,
      title,
      rationale: options.rationale,
      payload: input as Record<string, unknown>,
      preview,
      runId: options.runId,
      stepId: options.stepId,
      agentId: options.agentId,
      requestedForId: options.requestedForId ?? ctx.userId,
      expiresAfterHours: options.approvalExpiryHours ?? 48,
    });

    return { status: 'needs_approval', approvalId: approval.id, preview, riskLevel: tool.risk, title };
  }

  /* 5 — execute */
  try {
    const result = await tool.execute({ ctx, agentId: options.agentId, runId: options.runId }, input);
    return { status: 'ok', result, riskLevel: tool.risk };
  } catch (err) {
    if (!(err instanceof ValidationError) && !(err instanceof AuthorizationError)) {
      console.error(`[agent] tool ${toolName} threw:`, err);
    }
    await record(ctx, {
      action: 'agent.tool_failed',
      resourceType: 'tool',
      resourceId: toolName,
      riskLevel: tool.risk,
      metadata: { error: describeError(err) },
    });
    return {
      status: 'error',
      error: describeError(err),
      code: err instanceof ValidationError ? 'VALIDATION' : 'EXECUTION_FAILED',
      riskLevel: tool.risk,
    };
  }
}

/**
 * Whether this caller may run a tool of this risk class unattended.
 *
 * A human invoking a single tool in the UI *is* the approval: they were shown
 * the payload and they clicked. That shortcut is opt-in per call site
 * (`directUserAction`) rather than inferred from `ctx.actor.type`, because an
 * agent run or an automation started by a human still runs under that human's
 * authority — and the actions it composes on its own were never shown to
 * anyone. Inferring consent from the actor would let "run this automation"
 * silently authorise every email it later decided to send.
 *
 * Everything else must satisfy both its own policy *and* the workspace policy;
 * neither can unilaterally widen the other, and HIGH risk never auto-runs
 * unless an admin explicitly enabled it at workspace level.
 */
async function mayAutoRun(ctx: Ctx, risk: RiskLevel, options: DispatchOptions): Promise<boolean> {
  if (options.directUserAction && ctx.actor.type === 'user') return true;

  const agentPolicy = options.autoApprove ?? ['low'];
  if (!agentPolicy.includes(risk)) return false;

  const [ws] = await ctx.db
    .select({ aiSettings: workspaces.aiSettings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  const workspacePolicy = ws?.aiSettings?.autoApprove ?? { low: true, medium: false, high: false };
  return workspacePolicy[risk] === true;
}

function titleFor(toolName: string, preview: ApprovalPreview): string {
  switch (preview.kind) {
    case 'email':
      return `Send email: "${preview.subject}"`;
    case 'record_diff':
      return `Update ${preview.recordType}: ${preview.recordLabel}`;
    case 'bulk':
      return `Bulk change: ${preview.itemCount} records`;
    default:
      return toolName.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

function describeError(err: unknown): string {
  if (err instanceof ValidationError || err instanceof AuthorizationError) return err.message;
  if (err instanceof Error) {
    // Don't leak internals (SQL, stack frames) into model context or the UI.
    return /^[\w\s.,'"()-]{1,300}$/.test(err.message) ? err.message : 'The tool failed to complete.';
  }
  return 'The tool failed to complete.';
}

/** Import side-effect: registers the built-in tool set exactly once. */
let loaded = false;
export async function ensureToolsLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await import('./tools/read');
  await import('./tools/write');
}
