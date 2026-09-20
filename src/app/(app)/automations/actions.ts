'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCtx, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import {
  deleteAutomation,
  runAutomation,
  saveAutomation,
  setAutomationEnabled,
} from '@/server/automations/engine';
import type { ActionResult } from '@/app/actions';

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[automation-action] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('and'), children: z.array(conditionSchema) }),
    z.object({ op: z.literal('or'), children: z.array(conditionSchema) }),
    z.object({
      op: z.literal('cmp'),
      field: z.string().min(1),
      comparator: z.enum([
        'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
        'contains', 'not_contains', 'is_empty', 'is_not_empty', 'in',
      ]),
      value: z.unknown().optional(),
    }),
  ]),
);

const saveSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(400).optional(),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('event'), event: z.string().min(3) }),
    z.object({ kind: z.literal('schedule'), cron: z.string().min(5), timezone: z.string().default('UTC') }),
    z.object({ kind: z.literal('webhook') }),
  ]),
  conditions: conditionSchema.nullable(),
  actions: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum([
          'ask_ai', 'update_record', 'create_task', 'draft_email',
          'send_slack', 'run_agent', 'call_webhook', 'add_note',
        ]),
        params: z.record(z.string(), z.unknown()),
        riskLevel: z.enum(['low', 'medium', 'high']),
      }),
    )
    .min(1, 'Add at least one action.'),
  enabled: z.boolean().default(true),
});

export async function saveAutomationAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'That automation is not valid.' };
    }
    const ctx = await requireCtx();
    const id = await saveAutomation(ctx, parsed.data as never);

    revalidatePath('/automations');
    return { ok: true, data: { id }, message: parsed.data.id ? 'Automation updated.' : 'Automation created.' };
  });
}

export async function setAutomationEnabledAction(
  automationId: string,
  enabled: boolean,
): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await setAutomationEnabled(ctx, automationId, enabled);
    revalidatePath('/automations');
    return { ok: true };
  });
}

export async function runAutomationAction(
  automationId: string,
): Promise<ActionResult<{ status: string; detail: string }>> {
  return guard<{ status: string; detail: string }>(async () => {
    const ctx = await requireCtx();
    const result = await runAutomation(ctx, automationId, {});

    revalidatePath('/automations');
    revalidatePath('/inbox');

    const detail =
      result.status === 'skipped'
        ? 'Conditions did not match, so no actions ran.'
        : result.actionResults.map((r) => `${r.kind}: ${r.status}`).join(' · ');

    return { ok: true, data: { status: result.status, detail }, message: detail };
  });
}

export async function deleteAutomationAction(automationId: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await deleteAutomation(ctx, automationId);
    revalidatePath('/automations');
    return { ok: true, message: 'Automation deleted.' };
  });
}
