import { and, desc, eq, sql } from 'drizzle-orm';
import { evalCases, evalResults, evalRuns, type Grader, type LearningTask } from '@/db/schema';
import {
  extractChurnRisk,
  extractCommitments,
  extractDefects,
  extractFacts,
  extractObjections,
  extractProductSignals,
  type Utterance,
} from '@/lib/ai/local/extract';
import { getLanguageModel } from '@/lib/ai';
import { scope, type Ctx } from '../context';

/**
 * Scoring.
 *
 * Every enabled case is replayed against the *current* engine and graded. The
 * point is not the absolute number — a corpus grown from real corrections is
 * biased toward the hard cases by construction, so a 70% pass rate here is not
 * "70% accurate in production". The point is the delta: this number moving
 * down after a change means the change broke something a human had already
 * told us was right.
 *
 * Extraction tasks run against the deterministic local extractors directly
 * rather than through the provider abstraction, so a run is reproducible and
 * costs nothing even when a hosted model is configured. Answer-shaped tasks
 * need the configured provider and are graded loosely.
 */

export type EvalRunSummary = {
  runId: string;
  total: number;
  passed: number;
  failed: number;
  byTask: Record<string, { passed: number; total: number }>;
  latencyMs: number;
  failures: { caseId: string; task: string; label: string; detail: string }[];
};

export async function runEvaluation(
  ctx: Ctx,
  options: { trigger?: 'manual' | 'scheduled' | 'ci' | 'post_change'; task?: LearningTask } = {},
): Promise<EvalRunSummary> {
  const started = Date.now();
  const model = getLanguageModel();

  const cases = await ctx.db
    .select()
    .from(evalCases)
    .where(
      and(
        scope(ctx, evalCases),
        eq(evalCases.enabled, true),
        options.task ? eq(evalCases.task, options.task) : undefined,
      ),
    )
    .orderBy(evalCases.task, evalCases.createdAt);

  const [run] = await ctx.db
    .insert(evalRuns)
    .values({
      workspaceId: ctx.workspaceId,
      trigger: options.trigger ?? 'manual',
      model: model.id,
      totalCases: cases.length,
      startedAt: new Date(started),
    })
    .returning({ id: evalRuns.id });

  const runId = run!.id;
  const byTask: Record<string, { passed: number; total: number }> = {};
  const failures: EvalRunSummary['failures'] = [];
  let passed = 0;

  for (const c of cases) {
    const caseStarted = Date.now();
    let actual: unknown = null;
    let ok = false;
    let detail = '';

    try {
      actual = await produce(c.task as LearningTask, c.inputText, c.inputMeta);
      const graded = grade(c.grader as Grader, c.expected, actual);
      ok = graded.ok;
      detail = graded.detail;
    } catch (err) {
      ok = false;
      detail = `threw: ${(err as Error).message.slice(0, 200)}`;
    }

    const bucket = (byTask[c.task] ??= { passed: 0, total: 0 });
    bucket.total++;
    if (ok) {
      bucket.passed++;
      passed++;
    } else {
      failures.push({ caseId: c.id, task: c.task, label: c.label, detail });
    }

    await ctx.db.insert(evalResults).values({
      workspaceId: ctx.workspaceId,
      runId,
      caseId: c.id,
      task: c.task,
      passed: ok,
      actual: truncate(actual),
      detail: detail || null,
      latencyMs: Date.now() - caseStarted,
    });
  }

  const latencyMs = Date.now() - started;
  await ctx.db
    .update(evalRuns)
    .set({
      passed,
      failed: cases.length - passed,
      scoreByTask: byTask,
      finishedAt: new Date(),
      latencyMs,
    })
    .where(eq(evalRuns.id, runId));

  return {
    runId,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    byTask,
    latencyMs,
    failures,
  };
}

/** Replay one case through the capability it tests. */
async function produce(
  task: LearningTask,
  inputText: string,
  meta: Record<string, unknown>,
): Promise<unknown> {
  const utterance: Utterance = {
    text: inputText,
    isCustomer: meta['isCustomer'] !== false,
    index: 0,
    ...(typeof meta['speaker'] === 'string' ? { speaker: meta['speaker'] } : {}),
  };

  switch (task) {
    case 'extract_commitments':
      return extractCommitments([utterance]);
    case 'extract_objections':
      return extractObjections([utterance]);
    case 'extract_product_signals':
      return {
        signals: [...extractProductSignals([utterance]), ...extractDefects([utterance])],
        churnRisk: extractChurnRisk([utterance]),
      };
    case 'extract_facts':
      return extractFacts([utterance]);
    case 'answer_question': {
      const model = getLanguageModel();
      const out = await model.complete({
        system: 'You answer questions about customers from evidence.',
        messages: [{ role: 'user', content: inputText }],
      });
      return { answer: out.text };
    }
    default:
      // Tasks with no deterministic replay path are recorded as skipped rather
      // than silently counted as passes.
      throw new Error(`no replay path for task "${task}"`);
  }
}

function grade(
  grader: Grader,
  expected: Record<string, unknown>,
  actual: unknown,
): { ok: boolean; detail: string } {
  const items = countable(actual);

  switch (grader) {
    case 'empty':
      return items === 0
        ? { ok: true, detail: '' }
        : { ok: false, detail: `expected nothing, got ${items}` };

    case 'non_empty':
      return items > 0
        ? { ok: true, detail: '' }
        : { ok: false, detail: 'expected at least one result, got none' };

    case 'category': {
      const want = String(expected['category'] ?? '');
      const got = categories(actual);
      return got.includes(want)
        ? { ok: true, detail: '' }
        : { ok: false, detail: `expected category "${want}", got [${got.join(', ') || 'none'}]` };
    }

    case 'contains': {
      const want = Array.isArray(expected['contains'])
        ? (expected['contains'] as unknown[]).map(String)
        : [];
      const hay = JSON.stringify(actual ?? '').toLowerCase();
      const missing = want.filter((w) => !hay.includes(w.toLowerCase()));
      return missing.length === 0
        ? { ok: true, detail: '' }
        : { ok: false, detail: `missing: ${missing.join(', ')}` };
    }

    case 'numeric_range': {
      const n = firstNumber(actual);
      const min = Number(expected['min'] ?? Number.NEGATIVE_INFINITY);
      const max = Number(expected['max'] ?? Number.POSITIVE_INFINITY);
      if (n === null) return { ok: false, detail: 'no numeric value in output' };
      return n >= min && n <= max
        ? { ok: true, detail: '' }
        : { ok: false, detail: `${n} outside ${min}..${max}` };
    }
  }
}

function countable(actual: unknown): number {
  if (Array.isArray(actual)) return actual.length;
  if (actual && typeof actual === 'object') {
    const o = actual as Record<string, unknown>;
    // The product-signal shape: an array plus a churn verdict.
    const arrays = Object.values(o).filter(Array.isArray) as unknown[][];
    const present = arrays.reduce((n, a) => n + a.length, 0);
    const churn = o['churnRisk'];
    const churnPresent =
      churn && typeof churn === 'object' && (churn as Record<string, unknown>)['present'] === true
        ? 1
        : 0;
    return present + churnPresent;
  }
  return actual ? 1 : 0;
}

function categories(actual: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['category'] === 'string') out.push(o['category']);
      Object.values(o).forEach(walk);
    }
  };
  walk(actual);
  return [...new Set(out)];
}

function firstNumber(actual: unknown): number | null {
  if (typeof actual === 'number') return actual;
  if (Array.isArray(actual)) {
    for (const v of actual) {
      const n = firstNumber(v);
      if (n !== null) return n;
    }
    return null;
  }
  if (actual && typeof actual === 'object') {
    for (const v of Object.values(actual as Record<string, unknown>)) {
      const n = firstNumber(v);
      if (n !== null) return n;
    }
  }
  return null;
}

/** Keep result rows bounded; a full extraction dump can be large. */
function truncate(value: unknown): unknown {
  const s = JSON.stringify(value ?? null);
  if (s.length <= 4000) return value;
  return { truncated: true, preview: s.slice(0, 4000) };
}

/* ── Reads for the dashboard ───────────────────────────────────────────────── */

export async function recentRuns(ctx: Ctx, limit = 20) {
  return ctx.db
    .select()
    .from(evalRuns)
    .where(scope(ctx, evalRuns))
    .orderBy(desc(evalRuns.startedAt))
    .limit(limit);
}

export async function latestRun(ctx: Ctx) {
  const [row] = await recentRuns(ctx, 1);
  return row ?? null;
}

/** Cases failing in the most recent run, with their reason. */
export async function currentFailures(ctx: Ctx, limit = 25) {
  const run = await latestRun(ctx);
  if (!run) return [];

  return ctx.db
    .select({
      caseId: evalResults.caseId,
      task: evalResults.task,
      detail: evalResults.detail,
      label: evalCases.label,
      inputText: evalCases.inputText,
      grader: evalCases.grader,
      origin: evalCases.origin,
    })
    .from(evalResults)
    .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(and(scope(ctx, evalResults), eq(evalResults.runId, run.id), eq(evalResults.passed, false)))
    .limit(limit);
}

export async function caseCounts(ctx: Ctx): Promise<{ task: string; n: number; origin: string }[]> {
  const rows = await ctx.db
    .select({
      task: evalCases.task,
      origin: evalCases.origin,
      n: sql<number>`count(*)::int`,
    })
    .from(evalCases)
    .where(and(scope(ctx, evalCases), eq(evalCases.enabled, true)))
    .groupBy(evalCases.task, evalCases.origin);

  return rows.map((r) => ({ task: r.task, origin: r.origin, n: Number(r.n) }));
}
