import { and, desc, eq, sql } from 'drizzle-orm';
import {
  evalCases,
  evalResults,
  improvementProposals,
  type LearningTask,
} from '@/db/schema';
import { scope, scoped, type Ctx } from '../context';
import { record } from '../audit';

/**
 * Closing the loop.
 *
 * A failing eval case is a fact. What to change because of it is a judgement,
 * and this module makes that judgement explicit rather than acting on it.
 *
 * Each proposal names a file and a symbol, describes the change as structured
 * data, and cites the cases that justify it. It is then raised through the same
 * approval gate as any other consequential action, so a human sees the exact
 * proposed change before anything moves.
 *
 * Deliberately absent: any path that edits source, prompts or rules
 * automatically. An extraction rule that widened itself overnight to satisfy
 * four cases could quietly flood every account with false objections, and the
 * only signal would be users trusting the product less. The whole product
 * argues that consequential changes need a human; its own self-improvement is
 * not an exception.
 */

/** Where each capability's behaviour actually lives, for a useful proposal. */
const TARGETS: Record<LearningTask, string> = {
  extract_commitments: 'src/lib/ai/local/extract.ts · COMMIT_MODALS / REQUEST_NOT_PROMISE',
  extract_objections: 'src/lib/ai/local/extract.ts · OBJECTION_RULES',
  extract_product_signals: 'src/lib/ai/local/extract.ts · SIGNAL_LEXICON / REQUEST_CUES',
  extract_facts: 'src/lib/ai/local/extract.ts · FACT_PATTERNS',
  answer_question: 'src/lib/ai/local/compose.ts · composeAnswer',
  draft_email: 'src/lib/ai/local/compose.ts · composeFollowUp',
  score_deal_health: 'src/server/intelligence/health.ts · factor weights',
  tool_choice: 'src/lib/ai/providers/local.ts · planToolCall',
  summarize: 'src/server/memory/summarize.ts',
};

/** Below this, a cluster is noise rather than a pattern worth acting on. */
const MIN_CLUSTER = 2;

export type ProposalDraft = {
  task: LearningTask;
  title: string;
  rationale: string;
  target: string;
  change: Record<string, unknown>;
  failingCaseIds: string[];
};

export async function proposeImprovements(ctx: Ctx, runId: string): Promise<ProposalDraft[]> {
  const failures = await ctx.db
    .select({
      caseId: evalResults.caseId,
      task: evalResults.task,
      detail: evalResults.detail,
      grader: evalCases.grader,
      label: evalCases.label,
      inputText: evalCases.inputText,
    })
    .from(evalResults)
    .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(
      and(scope(ctx, evalResults), eq(evalResults.runId, runId), eq(evalResults.passed, false)),
    );

  if (failures.length === 0) return [];

  /**
   * Cluster by (task, direction). Direction is what separates the two
   * fixes that pull in opposite directions: over-firing wants the rule
   * narrowed, under-firing wants it widened. Mixing them into one proposal
   * would produce a change request nobody could act on.
   */
  const clusters = new Map<string, typeof failures>();
  for (const f of failures) {
    const direction =
      f.grader === 'empty' ? 'over_fires' : f.grader === 'non_empty' ? 'under_fires' : 'wrong_shape';
    const key = `${f.task}::${direction}`;
    const bucket = clusters.get(key) ?? [];
    bucket.push(f);
    clusters.set(key, bucket);
  }

  const drafts: ProposalDraft[] = [];

  for (const [key, group] of clusters) {
    if (group.length < MIN_CLUSTER) continue;
    const [taskRaw, direction] = key.split('::');
    const task = taskRaw as LearningTask;
    const caseIds = group.map((g) => g.caseId);
    const examples = group.slice(0, 3).map((g) => g.inputText.replace(/\s+/g, ' ').slice(0, 140));

    if (direction === 'over_fires') {
      drafts.push({
        task,
        title: `${label(task)} fires on ${group.length} inputs a human said were clean`,
        rationale:
          `Each of these ${group.length} inputs was rejected by a person as not containing ` +
          `anything to extract, and the engine still produces a result for them. Over-firing is ` +
          `the more damaging direction: a false objection ages into deal health, the inbox and ` +
          `the forecast, and the rep who sees it once trusts the next one less.`,
        target: TARGETS[task],
        change: {
          direction: 'narrow',
          suggestion:
            'Add a structural guard rejecting these shapes before the cue match, in the style of ' +
            'isNonObjectionFragment — length floor, list-marker and question detection.',
          examples,
        },
        failingCaseIds: caseIds,
      });
      continue;
    }

    if (direction === 'under_fires') {
      drafts.push({
        task,
        title: `${label(task)} misses ${group.length} inputs a human confirmed`,
        rationale:
          `A person accepted the engine's output on these ${group.length} inputs, and it now ` +
          `returns nothing for them. Either a cue was removed or a guard grew too strict — ` +
          `check the most recent narrowing change against these examples before widening anything.`,
        target: TARGETS[task],
        change: {
          direction: 'widen',
          suggestion:
            'Compare each example against the guard chain and identify which predicate now ' +
            'rejects it. Prefer relaxing one predicate over adding a new cue.',
          examples,
        },
        failingCaseIds: caseIds,
      });
      continue;
    }

    drafts.push({
      task,
      title: `${label(task)} produces the wrong shape on ${group.length} corrected cases`,
      rationale:
        `A person corrected the engine on these ${group.length} inputs and the corrected value ` +
        `is still not what comes back. These are the highest-value failures in the corpus: the ` +
        `right answer is already known and written down.`,
      target: TARGETS[task],
      change: {
        direction: 'reclassify',
        suggestion:
          'Each case carries the human-supplied expectation. Align classification with those ' +
          'before touching cue coverage.',
        details: group.slice(0, 5).map((g) => ({ label: g.label, detail: g.detail })),
      },
      failingCaseIds: caseIds,
    });
  }

  return drafts;
}

/**
 * Persist drafts and raise each through the approval gate.
 *
 * `propose_improvement` is registered as a HIGH-risk tool, so it cannot
 * auto-run for an agent under any configuration — the proposal lands in the
 * Inbox with its rationale and evidence, and a human decides.
 */
export async function raiseProposals(
  ctx: Ctx,
  runId: string,
  drafts: ProposalDraft[],
): Promise<{ created: number; proposalIds: string[] }> {
  const ids: string[] = [];

  for (const d of drafts) {
    // One open proposal per (task, target) — re-raising the same change every
    // run would bury the Inbox in duplicates.
    const [existing] = await ctx.db
      .select({ id: improvementProposals.id })
      .from(improvementProposals)
      .where(
        scoped(
          ctx,
          improvementProposals,
          eq(improvementProposals.task, d.task),
          eq(improvementProposals.target, d.target),
          eq(improvementProposals.status, 'proposed'),
        ),
      )
      .limit(1);

    if (existing) {
      await ctx.db
        .update(improvementProposals)
        .set({
          runId,
          title: d.title,
          rationale: d.rationale,
          change: d.change,
          failingCaseIds: d.failingCaseIds,
        })
        .where(eq(improvementProposals.id, existing.id));
      ids.push(existing.id);
      continue;
    }

    const [created] = await ctx.db
      .insert(improvementProposals)
      .values({
        workspaceId: ctx.workspaceId,
        runId,
        task: d.task,
        title: d.title,
        rationale: d.rationale,
        target: d.target,
        change: d.change,
        failingCaseIds: d.failingCaseIds,
        status: 'proposed',
      })
      .returning({ id: improvementProposals.id });

    if (created) {
      ids.push(created.id);
      await record(ctx, {
        action: 'learning.proposal_raised',
        resourceType: 'improvement_proposal',
        resourceId: created.id,
        riskLevel: 'high',
        metadata: { task: d.task, target: d.target, cases: d.failingCaseIds.length },
      });
    }
  }

  return { created: ids.length, proposalIds: ids };
}

export async function decideProposal(
  ctx: Ctx,
  proposalId: string,
  decision: 'approved' | 'rejected' | 'applied',
): Promise<void> {
  await ctx.db
    .update(improvementProposals)
    .set({ status: decision, decidedById: ctx.userId, decidedAt: new Date() })
    .where(scoped(ctx, improvementProposals, eq(improvementProposals.id, proposalId)));

  await record(ctx, {
    action: `learning.proposal_${decision}`,
    resourceType: 'improvement_proposal',
    resourceId: proposalId,
    riskLevel: 'high',
    metadata: { decision },
  });
}

export async function openProposals(ctx: Ctx, limit = 20) {
  return ctx.db
    .select()
    .from(improvementProposals)
    .where(scoped(ctx, improvementProposals, eq(improvementProposals.status, 'proposed')))
    .orderBy(desc(improvementProposals.createdAt))
    .limit(limit);
}

export async function proposalCounts(ctx: Ctx): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ status: improvementProposals.status, n: sql<number>`count(*)::int` })
    .from(improvementProposals)
    .where(scope(ctx, improvementProposals))
    .groupBy(improvementProposals.status);

  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

function label(task: LearningTask): string {
  return task.replace(/^extract_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
