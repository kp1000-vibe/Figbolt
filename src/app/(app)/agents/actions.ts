'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCtx, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import {
  compileAgent,
  deleteAgent,
  saveAgent,
  setAgentEnabled,
  type CompiledAgent,
} from '@/server/agents/manage';
import type { ActionResult } from '@/app/actions';

/** Agent management actions. See `src/app/actions.ts` for the shared contract. */

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[agent-action] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

export async function compileAgentAction(description: string): Promise<ActionResult<CompiledAgent>> {
  return guard<CompiledAgent>(async () => {
    const ctx = await requireCtx();
    const compiled = await compileAgent(ctx, description);
    return { ok: true, data: compiled };
  });
}

const saveSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).optional(),
  prompt: z.string().trim().min(10),
  instructions: z.string().trim().min(10),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({
      kind: z.literal('schedule'),
      cron: z.string().trim().min(5),
      timezone: z.string().default('UTC'),
    }),
    z.object({ kind: z.literal('event'), event: z.string().trim().min(3) }),
  ]),
  toolNames: z.array(z.string()).min(1, 'Enable at least one tool.').max(24),
  steps: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['retrieve', 'analyze', 'tool', 'decide', 'act', 'notify']),
      title: z.string(),
      detail: z.string().optional(),
      tool: z.string().optional(),
    }),
  ),
  filters: z.record(z.string(), z.unknown()).optional(),
  autoApprove: z.array(z.enum(['low', 'medium', 'high'])),
  enabled: z.boolean().default(true),
  runAsUserId: z.string().optional(),
});

export async function saveAgentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'That agent configuration is not valid.' };
    }

    const ctx = await requireCtx();
    const id = await saveAgent(ctx, {
      ...parsed.data,
      approvalPolicy: {
        autoApprove: parsed.data.autoApprove,
        notify: 'record_owner',
        expiresAfterHours: 48,
      },
    });

    revalidatePath('/agents');
    revalidatePath(`/agents/${id}`);
    return { ok: true, data: { id }, message: parsed.data.id ? 'Agent updated.' : 'Agent created.' };
  });
}

export async function setAgentEnabledAction(
  agentId: string,
  enabled: boolean,
): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await setAgentEnabled(ctx, agentId, enabled);
    revalidatePath('/agents');
    revalidatePath(`/agents/${agentId}`);
    return { ok: true };
  });
}

export async function deleteAgentAction(agentId: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await deleteAgent(ctx, agentId);
    revalidatePath('/agents');
    return { ok: true, message: 'Agent deleted.' };
  });
}
