'use server';

import { revalidatePath } from 'next/cache';
import { requireCtx, ValidationError, ctxAssert } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import { bootstrapEvalCases } from '@/server/learning/bootstrap';
import { promoteSignals } from '@/server/learning/promote';
import { runEvaluation } from '@/server/learning/evaluate';
import { proposeImprovements, raiseProposals, decideProposal } from '@/server/learning/propose';
import type { ActionResult } from '@/app/actions';

/**
 * Running the loop from the UI.
 *
 * Scoring is read-only against the engine, so it needs no approval. Deciding a
 * proposal is the consequential half and is gated on `agent:manage` — the same
 * permission that lets someone change what agents may do, because approving a
 * change to extraction behaviour has the same blast radius.
 */

export async function runLoopAction(): Promise<
  ActionResult<{ passed: number; total: number; proposals: number }>
> {
  try {
    const ctx = await requireCtx();
    ctxAssert(ctx, 'ai:ask');

    await bootstrapEvalCases(ctx);
    await promoteSignals(ctx);
    const summary = await runEvaluation(ctx, { trigger: 'manual' });

    let proposals = 0;
    if (summary.failures.length > 0) {
      ctxAssert(ctx, 'agent:manage');
      const drafts = await proposeImprovements(ctx, summary.runId);
      const raised = await raiseProposals(ctx, summary.runId, drafts);
      proposals = raised.created;
    }

    revalidatePath('/learning');
    return {
      ok: true,
      data: { passed: summary.passed, total: summary.total, proposals },
      message:
        summary.total === 0
          ? 'No cases yet — approve or reject an agent proposal to start the corpus.'
          : `${summary.passed}/${summary.total} passed` +
            (proposals ? ` · ${proposals} proposal(s) raised` : ''),
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[learning] runLoopAction failed:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

export async function decideProposalAction(
  proposalId: string,
  decision: 'approved' | 'rejected',
): Promise<ActionResult> {
  try {
    const ctx = await requireCtx();
    // Approving a change to how the engine reads customer conversations is at
    // least as consequential as editing an agent, so it takes that permission.
    ctxAssert(ctx, 'agent:manage');
    await decideProposal(ctx, proposalId, decision);
    revalidatePath('/learning');
    return {
      ok: true,
      message:
        decision === 'approved'
          ? 'Marked approved. It still needs a developer to make the change — nothing was applied automatically.'
          : 'Rejected. It will not be raised again from the same failures.',
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[learning] decideProposalAction failed:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}
