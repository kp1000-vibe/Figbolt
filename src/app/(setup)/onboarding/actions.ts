'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { pipelineStages, pipelines, workspaceMembers, workspaces } from '@/db/schema';
import { requireUser, setActiveWorkspace } from '@/lib/auth/session';
import { systemCtx, ValidationError } from '@/server/context';
import { record } from '@/server/audit';
import type { ActionResult } from '@/app/actions';

/**
 * Onboarding actions.
 *
 * These run before a `Ctx` exists (there is no workspace yet), so they resolve
 * the user directly and construct a system context only once a workspace id is
 * available.
 */

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    console.error('[onboarding] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

/** The default pipeline every new workspace starts with. */
const DEFAULT_STAGES = [
  { name: 'Discovery', probability: 10, type: 'open' as const, color: '#8b9bb4', entryCriteria: 'A named owner has described a real, current problem.' },
  { name: 'Evaluation', probability: 30, type: 'open' as const, color: '#5b8def', entryCriteria: 'Technical fit confirmed; security or IT review under way.' },
  { name: 'Proposal', probability: 55, type: 'open' as const, color: '#7c6df2', entryCriteria: 'Pricing shared and scope agreed with the champion.' },
  { name: 'Negotiation', probability: 78, type: 'open' as const, color: '#e0954a', entryCriteria: 'Commercial terms under discussion; procurement or legal engaged.' },
  { name: 'Closed Won', probability: 100, type: 'won' as const, color: '#3fa66b', entryCriteria: 'Contract signed.' },
  { name: 'Closed Lost', probability: 0, type: 'lost' as const, color: '#c85a5a', entryCriteria: 'The customer chose not to proceed.' },
];

export async function createWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const parsed = z
      .object({ name: z.string().trim().min(2, 'Give the workspace a name.').max(120) })
      .safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid name.' };
    }

    const user = await requireUser();
    const db = await getDb();

    // Slugs must be unique; append a short suffix rather than failing.
    const base = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'workspace';

    let slug = base;
    for (let attempt = 0; attempt < 6; attempt++) {
      const [taken] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1);
      if (!taken) break;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({
        name: parsed.data.name,
        slug,
        onboardingStep: 'company',
        aiSettings: {
          // Ship conservative: read freely, hold everything that writes.
          autoApprove: { low: true, medium: false, high: false },
          autonomousEmailAgentIds: [],
          maxStepsPerRun: 12,
          redactPiiInPrompts: false,
        },
      })
      .returning({ id: workspaces.id });

    const workspaceId = workspace!.id;

    await db.insert(workspaceMembers).values({
      workspaceId,
      userId: user.id,
      role: 'owner',
      status: 'active',
    });

    // A workspace without a pipeline cannot hold an opportunity, so create one
    // now rather than making it another onboarding step that can be skipped.
    const [pipeline] = await db
      .insert(pipelines)
      .values({
        workspaceId,
        name: 'Sales Pipeline',
        description: 'Default pipeline.',
        isDefault: true,
      })
      .returning({ id: pipelines.id });

    for (const [index, stage] of DEFAULT_STAGES.entries()) {
      await db.insert(pipelineStages).values({
        workspaceId,
        pipelineId: pipeline!.id,
        name: stage.name,
        position: index,
        probability: stage.probability,
        type: stage.type,
        color: stage.color,
        entryCriteria: stage.entryCriteria,
      });
    }

    await setActiveWorkspace(workspaceId);

    const ctx = await systemCtx(workspaceId, 'Onboarding');
    await record(
      { ...ctx, userId: user.id, actor: { type: 'user', id: user.id, label: user.name } },
      {
        action: 'workspace.created',
        resourceType: 'workspace',
        resourceId: workspaceId,
        riskLevel: 'medium',
        metadata: { name: parsed.data.name, slug },
      },
    );

    return { ok: true, data: { id: workspaceId } };
  });
}

const completeSchema = z.object({
  workspaceId: z.string().min(1),
  step: z.string().min(1),
  complete: z.boolean().optional(),
  companyContext: z
    .object({
      whatWeSell: z.string().trim().max(2000).optional(),
      idealCustomer: z.string().trim().max(2000).optional(),
      targetIndustries: z.array(z.string().trim().max(80)).max(20).optional(),
      qualificationCriteria: z.string().trim().max(2000).optional(),
      salesProcess: z.string().trim().max(2000).optional(),
      commonObjections: z.array(z.string().trim().max(200)).max(20).optional(),
      competitors: z.array(z.string().trim().max(80)).max(20).optional(),
      differentiators: z.string().trim().max(2000).optional(),
    })
    .optional(),
});

export async function completeOnboardingAction(input: unknown): Promise<ActionResult> {
  return guard(async () => {
    const parsed = completeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'Invalid request.' };

    const user = await requireUser();
    const db = await getDb();

    // Re-verify membership: the workspace id came from the client.
    const [membership] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, parsed.data.workspaceId),
          eq(workspaceMembers.userId, user.id),
          eq(workspaceMembers.status, 'active'),
        ),
      )
      .limit(1);

    if (!membership) return { ok: false, error: 'You do not have access to that workspace.' };

    await db
      .update(workspaces)
      .set({
        onboardingStep: parsed.data.step,
        ...(parsed.data.companyContext ? { companyContext: parsed.data.companyContext } : {}),
        ...(parsed.data.complete ? { onboardingCompletedAt: new Date() } : {}),
      })
      .where(eq(workspaces.id, parsed.data.workspaceId));

    revalidatePath('/onboarding');
    if (parsed.data.complete) revalidatePath('/home');

    return { ok: true };
  });
}

/**
 * Join the seeded demo workspace.
 *
 * Only works when a demo workspace exists (i.e. `npm run db:seed` was run).
 * It adds the current user as a viewer rather than an owner — the demo is for
 * exploring, and a visitor should not be able to reconfigure it.
 */
export async function seedDemoAction(): Promise<ActionResult> {
  return guard(async () => {
    const user = await requireUser();
    const db = await getDb();

    const [demo] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.isDemo, true), isNull(workspaces.deletedAt)))
      .limit(1);

    if (!demo) {
      throw new ValidationError(
        'No demo workspace is present. Run `npm run db:seed` to create one, then reload.',
      );
    }

    const [existing] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, demo.id), eq(workspaceMembers.userId, user.id)),
      )
      .limit(1);

    if (!existing) {
      await db.insert(workspaceMembers).values({
        workspaceId: demo.id,
        userId: user.id,
        role: 'viewer',
        status: 'active',
      });
    }

    await setActiveWorkspace(demo.id);
    revalidatePath('/home');
    return { ok: true };
  });
}
