'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCtx, ctxAssert, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import { workspaces, workspaceMembers, ROLES } from '@/db/schema';
import { record } from '@/server/audit';
import type { ActionResult } from '@/app/actions';

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[settings-action] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

const contextSchema = z.object({
  whatWeSell: z.string().trim().max(2000).optional(),
  idealCustomer: z.string().trim().max(2000).optional(),
  targetIndustries: z.array(z.string().trim().max(80)).max(20).optional(),
  qualificationCriteria: z.string().trim().max(2000).optional(),
  salesProcess: z.string().trim().max(2000).optional(),
  commonObjections: z.array(z.string().trim().max(200)).max(20).optional(),
  competitors: z.array(z.string().trim().max(80)).max(20).optional(),
  differentiators: z.string().trim().max(2000).optional(),
});

export async function saveCompanyContextAction(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    ctxAssert(ctx, 'workspace:manage');

    const parsed = contextSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'That context is not valid.' };
    }

    await ctx.db
      .update(workspaces)
      .set({ companyContext: parsed.data })
      .where(eq(workspaces.id, ctx.workspaceId));

    await record(ctx, {
      action: 'workspace.context_updated',
      resourceType: 'workspace',
      resourceId: ctx.workspaceId,
      riskLevel: 'medium',
    });

    revalidatePath('/settings');
    return { ok: true, message: 'Company context saved. Agents will use it on the next run.' };
  });
}

const aiSettingsSchema = z.object({
  autoApprove: z.object({ low: z.boolean(), medium: z.boolean(), high: z.boolean() }),
  maxStepsPerRun: z.coerce.number().int().min(3).max(30),
  redactPiiInPrompts: z.boolean(),
  autonomousEmailAgentIds: z.array(z.string()).max(20).default([]),
});

export async function saveAiSettingsAction(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    ctxAssert(ctx, 'security:manage');

    const parsed = aiSettingsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Those settings are not valid.' };
    }

    await ctx.db
      .update(workspaces)
      .set({ aiSettings: parsed.data })
      .where(eq(workspaces.id, ctx.workspaceId));

    // Loosening the autonomy envelope is a security-relevant change, so it is
    // recorded at high risk with the before/after values.
    await record(ctx, {
      action: 'workspace.ai_settings_updated',
      resourceType: 'workspace',
      resourceId: ctx.workspaceId,
      riskLevel: 'high',
      metadata: {
        autoApprove: parsed.data.autoApprove,
        maxSteps: parsed.data.maxStepsPerRun,
        autonomousEmailAgents: parsed.data.autonomousEmailAgentIds.length,
      },
    });

    revalidatePath('/settings/ai');
    return { ok: true, message: 'AI permissions updated.' };
  });
}

export async function updateMemberRoleAction(
  userId: string,
  role: string,
): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    ctxAssert(ctx, 'member:manage');

    const parsed = z.enum(ROLES).safeParse(role);
    if (!parsed.success) return { ok: false, error: 'Unknown role.' };

    // Refuse to remove the last owner — a workspace with no owner cannot be
    // administered again.
    if (userId === ctx.userId && parsed.data !== 'owner') {
      const owners = await ctx.db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));
      const ownerCount = owners.length;
      if (ctx.session.role === 'owner' && ownerCount <= 1) {
        return { ok: false, error: 'You are the only owner. Promote someone else first.' };
      }
    }

    const [existing] = await ctx.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);

    await ctx.db
      .update(workspaceMembers)
      .set({ role: parsed.data })
      .where(eq(workspaceMembers.userId, userId));

    await record(ctx, {
      action: 'member.role_changed',
      resourceType: 'user',
      resourceId: userId,
      riskLevel: 'high',
      changes: { role: { from: existing?.role ?? null, to: parsed.data } },
    });

    revalidatePath('/settings/team');
    return { ok: true, message: `Role updated to ${parsed.data}.` };
  });
}
