'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCtx, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import { createTask, setCommitmentStatus, setTaskStatus } from '@/server/crm/tasks';
import { moveOpportunity } from '@/server/crm/opportunities';
import { decideApproval } from '@/server/approvals';
import { resolveNotification, snoozeNotification, rebuildInbox } from '@/server/inbox';
import { runAgent } from '@/server/agents/runtime';
import { refreshAccountMemory, refreshOpportunityMemory } from '@/server/memory/summarize';
import { computeInsights } from '@/server/intelligence/insights';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';

/**
 * Server actions shared across pages.
 *
 * Every action re-resolves the session and workspace through `requireCtx()`
 * rather than trusting anything the client sent, and every mutation that has a
 * risk class goes through `dispatchTool` so a human clicking a button and an
 * agent proposing the same thing traverse identical authorization and audit
 * paths. Errors are normalised to a small result shape so forms can render
 * them without a client-side error boundary.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string };

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    // Anything unexpected is logged server-side and reported generically —
    // an internal error message is not useful to a user and may leak detail.
    console.error('[action] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

/* ── Tasks & commitments ──────────────────────────────────────────────────── */

const createTaskSchema = z.object({
  title: z.string().trim().min(3, 'Give the task a title.').max(200),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueInDays: z.coerce.number().int().min(0).max(365).optional(),
  assigneeId: z.string().optional(),
  accountId: z.string().optional(),
  contactId: z.string().optional(),
  opportunityId: z.string().optional(),
  commitmentId: z.string().optional(),
});

export async function createTaskAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const parsed = createTaskSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid task.' };
    }
    const ctx = await requireCtx();
    const task = await createTask(ctx, {
      ...parsed.data,
      dueAt:
        parsed.data.dueInDays != null
          ? new Date(Date.now() + parsed.data.dueInDays * 86_400_000)
          : null,
    });

    revalidatePath('/tasks');
    revalidatePath('/home');
    if (parsed.data.accountId) revalidatePath(`/accounts/${parsed.data.accountId}`);
    if (parsed.data.opportunityId) revalidatePath(`/opportunities/${parsed.data.opportunityId}`);

    return { ok: true, data: { id: task.id }, message: `Created “${task.title}”.` };
  });
}

export async function setTaskStatusAction(
  taskId: string,
  status: 'open' | 'in_progress' | 'completed' | 'cancelled',
): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await setTaskStatus(ctx, taskId, status);
    revalidatePath('/tasks');
    revalidatePath('/home');
    revalidatePath('/inbox');
    return { ok: true, message: status === 'completed' ? 'Task completed.' : 'Task updated.' };
  });
}

export async function setCommitmentStatusAction(
  commitmentId: string,
  status: 'open' | 'fulfilled' | 'cancelled',
): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await setCommitmentStatus(ctx, commitmentId, status);
    revalidatePath('/tasks');
    revalidatePath('/inbox');
    revalidatePath('/home');
    return { ok: true, message: status === 'fulfilled' ? 'Marked as fulfilled.' : 'Commitment updated.' };
  });
}

/* ── Pipeline ─────────────────────────────────────────────────────────────── */

export async function moveOpportunityAction(input: {
  opportunityId: string;
  stageId: string;
  beforeId?: string;
  afterId?: string;
}): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await moveOpportunity(ctx, input);
    revalidatePath('/opportunities');
    revalidatePath(`/opportunities/${input.opportunityId}`);
    return { ok: true, message: 'Deal moved.' };
  });
}

/* ── Approvals ────────────────────────────────────────────────────────────── */

export async function decideApprovalAction(input: {
  approvalId: string;
  decision: 'approve' | 'reject';
  note?: string;
  editedPayload?: Record<string, unknown>;
}): Promise<ActionResult<{ executed: boolean; summary?: string }>> {
  return guard<{ executed: boolean; summary?: string }>(async () => {
    const ctx = await requireCtx();
    const result = await decideApproval(ctx, input);

    revalidatePath('/inbox');
    revalidatePath('/agents');
    revalidatePath('/home');

    if (input.decision === 'reject') {
      return { ok: true, data: { executed: false }, message: 'Rejected. Nothing was actioned.' };
    }
    if (result.executed) {
      return {
        ok: true,
        data: { executed: true },
        message: 'Approved and executed.',
      };
    }
    return { ok: false, error: result.error ?? 'Approved, but execution failed.' };
  });
}

/* ── Inbox ────────────────────────────────────────────────────────────────── */

export async function resolveNotificationAction(notificationId: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await resolveNotification(ctx, notificationId);
    revalidatePath('/inbox');
    revalidatePath('/home');
    return { ok: true, message: 'Marked as done.' };
  });
}

export async function snoozeNotificationAction(
  notificationId: string,
  days: number,
): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await snoozeNotification(ctx, notificationId, Math.min(Math.max(days, 1), 30));
    revalidatePath('/inbox');
    return { ok: true, message: `Snoozed for ${days} ${days === 1 ? 'day' : 'days'}.` };
  });
}

export async function refreshInboxAction(): Promise<ActionResult<{ count: number }>> {
  return guard(async () => {
    const ctx = await requireCtx();
    const count = await rebuildInbox(ctx);
    revalidatePath('/inbox');
    revalidatePath('/home');
    return { ok: true, data: { count }, message: `Rebuilt ${count} items.` };
  });
}

/* ── Agents ───────────────────────────────────────────────────────────────── */

export async function runAgentAction(agentId: string): Promise<ActionResult<{ runId: string; status: string }>> {
  return guard(async () => {
    const ctx = await requireCtx();
    const outcome = await runAgent(ctx, agentId, { kind: 'manual', detail: 'Run from the UI' });

    revalidatePath('/agents');
    revalidatePath(`/agents/${agentId}`);
    revalidatePath('/inbox');

    return {
      ok: true,
      data: { runId: outcome.runId, status: outcome.status },
      message:
        outcome.status === 'awaiting_approval'
          ? `Finished with ${outcome.pendingApprovals.length} action(s) awaiting your approval.`
          : outcome.status === 'failed'
            ? 'The run failed — open it to see where.'
            : 'Run complete.',
    };
  });
}

/* ── Memory refresh ───────────────────────────────────────────────────────── */

export async function refreshAccountMemoryAction(accountId: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await refreshAccountMemory(ctx, accountId);
    revalidatePath(`/accounts/${accountId}`);
    return { ok: true, message: 'Customer memory rebuilt from current evidence.' };
  });
}

export async function refreshOpportunityMemoryAction(opportunityId: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await refreshOpportunityMemory(ctx, opportunityId);
    revalidatePath(`/opportunities/${opportunityId}`);
    return { ok: true, message: 'Deal intelligence recomputed.' };
  });
}

export async function recomputeInsightsAction(): Promise<ActionResult<{ count: number }>> {
  return guard(async () => {
    const ctx = await requireCtx();
    const insights = await computeInsights(ctx);
    revalidatePath('/analytics');
    revalidatePath('/home');
    return { ok: true, data: { count: insights.length }, message: `Found ${insights.length} patterns.` };
  });
}

/* ── Generic tool invocation ──────────────────────────────────────────────── */

/**
 * Run a registered agent tool as the current user.
 *
 * Used by the "Draft email" / "Create task" buttons on AI recommendations. It
 * deliberately reuses the agent dispatcher instead of calling services
 * directly, so the recommendation a human accepts is audited exactly like the
 * one an agent proposes.
 */
export async function invokeToolAction(
  tool: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ summary: string; needsApproval?: boolean; approvalId?: string }>> {
  return guard<{ summary: string; needsApproval?: boolean; approvalId?: string }>(async () => {
    const ctx = await requireCtx();
    await ensureToolsLoaded();

    const outcome = await dispatchTool(ctx, tool, input, {
      rationale: 'Invoked directly from the UI.',
      // The user was shown this exact payload in the composer and clicked. That
      // click is the approval; nothing here is composed by a model on its own.
      directUserAction: true,
    });

    if (outcome.status === 'ok') {
      revalidatePath('/home');
      revalidatePath('/inbox');
      revalidatePath('/tasks');
      return { ok: true, data: { summary: outcome.result.summary }, message: outcome.result.summary };
    }
    if (outcome.status === 'needs_approval') {
      revalidatePath('/inbox');
      return {
        ok: true,
        data: { summary: outcome.title, needsApproval: true, approvalId: outcome.approvalId },
        message: 'Queued for approval.',
      };
    }
    return { ok: false, error: outcome.error };
  });
}
