import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  feedbackSignals,
  type LearningTask,
  type SignalKind,
} from '@/db/schema';
import { scope, scoped, type Ctx } from '../context';

/**
 * Capture.
 *
 * The signals here are not a new thing we ask users to do — they are the
 * judgements the product already required of them. Approving an agent's email
 * is a human saying "this output was correct". Editing the payload first is a
 * human saying "close, but here is the right answer", which is strictly more
 * information than a thumbs-down. Superseding a derived fact is a correction
 * with the evidence still attached.
 *
 * Capture is deliberately best-effort: a failure to record a signal must never
 * fail the action the user was actually taking. Learning is a by-product, not
 * a precondition.
 */

export type SignalInput = {
  kind: SignalKind;
  task: LearningTask;
  verdict: 'positive' | 'negative' | 'corrected';
  subjectType?: string | null;
  subjectId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** The text the engine read. Without it a case cannot be replayed. */
  inputText?: string | null;
  modelOutput?: unknown;
  humanOutput?: unknown;
  note?: string | null;
  confidence?: number | null;
  model?: string | null;
  occurredAt?: Date;
};

export async function recordSignal(ctx: Ctx, input: SignalInput): Promise<string | null> {
  try {
    const [row] = await ctx.db
      .insert(feedbackSignals)
      .values({
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        task: input.task,
        verdict: input.verdict,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        inputText: input.inputText ?? null,
        modelOutput: input.modelOutput ?? null,
        humanOutput: input.humanOutput ?? null,
        note: input.note ?? null,
        confidence: input.confidence ?? null,
        model: input.model ?? null,
        actorId: ctx.userId,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning({ id: feedbackSignals.id });
    return row?.id ?? null;
  } catch (err) {
    // Never let the learning loop break the thing being learned from.
    console.error('[learning] failed to record signal:', (err as Error).message);
    return null;
  }
}

/**
 * The task a tool's output belongs to.
 *
 * Approvals are keyed by tool name, but learning is keyed by capability: what
 * we want to measure is whether the engine drafts good email, not whether the
 * `draft_email` tool executed.
 */
export function taskForTool(tool: string): LearningTask | null {
  switch (tool) {
    case 'draft_email':
    case 'send_email':
      return 'draft_email';
    case 'create_task':
    case 'add_note':
    case 'create_contact':
    case 'create_account':
    case 'create_opportunity':
      return 'tool_choice';
    case 'change_pipeline_stage':
    case 'bulk_update_stage':
    case 'update_record':
      return 'tool_choice';
    case 'analyze_deal':
      return 'score_deal_health';
    default:
      return null;
  }
}

/** Counts for the learning dashboard, by task and verdict. */
export async function signalSummary(
  ctx: Ctx,
  sinceDays = 90,
): Promise<{ task: string; verdict: string; n: number }[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const rows = await ctx.db
    .select({
      task: feedbackSignals.task,
      verdict: feedbackSignals.verdict,
      n: sql<number>`count(*)::int`,
    })
    .from(feedbackSignals)
    .where(and(scope(ctx, feedbackSignals), gte(feedbackSignals.occurredAt, since)))
    .groupBy(feedbackSignals.task, feedbackSignals.verdict);

  return rows.map((r) => ({ task: r.task, verdict: r.verdict, n: Number(r.n) }));
}

/** Signals that carry a replayable input and have not yet become a case. */
export async function unpromotedSignals(ctx: Ctx, limit = 200) {
  return ctx.db
    .select()
    .from(feedbackSignals)
    .where(
      and(
        scope(ctx, feedbackSignals),
        isNull(feedbackSignals.promotedCaseId),
        sql`${feedbackSignals.inputText} IS NOT NULL AND length(${feedbackSignals.inputText}) > 20`,
      ),
    )
    .orderBy(desc(feedbackSignals.occurredAt))
    .limit(limit);
}

export async function recentSignals(ctx: Ctx, limit = 25) {
  return ctx.db
    .select()
    .from(feedbackSignals)
    .where(scope(ctx, feedbackSignals))
    .orderBy(desc(feedbackSignals.occurredAt))
    .limit(limit);
}

/**
 * Confidence calibration.
 *
 * The engine attaches a confidence to everything it extracts. If the outputs a
 * human rejects carry the same average confidence as the ones they accept,
 * that number is decoration and should not be shown as if it means something.
 * This is the query that catches that.
 */
export async function calibration(ctx: Ctx): Promise<
  { task: string; verdict: string; avgConfidence: number; n: number }[]
> {
  const rows = await ctx.db
    .select({
      task: feedbackSignals.task,
      verdict: feedbackSignals.verdict,
      avg: sql<number>`avg(${feedbackSignals.confidence})::float8`,
      n: sql<number>`count(*)::int`,
    })
    .from(feedbackSignals)
    .where(and(scope(ctx, feedbackSignals), sql`${feedbackSignals.confidence} IS NOT NULL`))
    .groupBy(feedbackSignals.task, feedbackSignals.verdict);

  return rows
    .filter((r) => r.avg != null)
    .map((r) => ({
      task: r.task,
      verdict: r.verdict,
      avgConfidence: Number(r.avg),
      n: Number(r.n),
    }));
}

export async function markPromoted(ctx: Ctx, signalId: string, caseId: string): Promise<void> {
  await ctx.db
    .update(feedbackSignals)
    .set({ promotedCaseId: caseId })
    .where(scoped(ctx, feedbackSignals, eq(feedbackSignals.id, signalId)));
}
