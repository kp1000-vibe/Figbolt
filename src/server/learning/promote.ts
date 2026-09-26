import { and, eq, sql } from 'drizzle-orm';
import { evalCases, feedbackSignals, type Grader, type LearningTask } from '@/db/schema';
import { scope, type Ctx } from '../context';
import { markPromoted, unpromotedSignals } from './signals';

/**
 * Distillation: signals become cases.
 *
 * Not every signal is worth keeping. A case earns its place only if it can be
 * *replayed* — we need the exact input the engine saw and an unambiguous
 * statement of what the right answer was. A thumbs-down with no input text is
 * a mood, not a test.
 *
 * The three shapes that promote cleanly:
 *
 *  - a rejection of an extraction  -> the engine should find nothing here
 *  - a correction of an extraction -> the engine should produce this instead
 *  - an accepted output            -> the engine should keep producing this
 *
 * Accepted outputs are the least informative but the most numerous, so they
 * are sampled rather than taken wholesale: a corpus of a thousand "this was
 * fine" cases would take an hour to run and tell you nothing a dozen wouldn't.
 */

const MAX_POSITIVE_PER_TASK = 12;

export type PromoteResult = {
  created: number;
  skipped: number;
  byTask: Record<string, number>;
};

export async function promoteSignals(ctx: Ctx, limit = 200): Promise<PromoteResult> {
  const signals = await unpromotedSignals(ctx, limit);

  // How many positive cases each task already holds, so sampling is stable
  // across runs rather than re-sampling the same task forever.
  const existing = await ctx.db
    .select({ task: evalCases.task, n: sql<number>`count(*)::int` })
    .from(evalCases)
    .where(and(scope(ctx, evalCases), eq(evalCases.origin, 'usage')))
    .groupBy(evalCases.task);

  const positiveCount = new Map<string, number>(existing.map((e) => [e.task, Number(e.n)]));

  const result: PromoteResult = { created: 0, skipped: 0, byTask: {} };

  for (const signal of signals) {
    const spec = caseFor(signal);
    if (!spec) {
      result.skipped++;
      continue;
    }

    if (signal.verdict === 'positive') {
      const held = positiveCount.get(signal.task) ?? 0;
      if (held >= MAX_POSITIVE_PER_TASK) {
        result.skipped++;
        continue;
      }
      positiveCount.set(signal.task, held + 1);
    }

    const [created] = await ctx.db
      .insert(evalCases)
      .values({
        workspaceId: ctx.workspaceId,
        task: signal.task,
        inputText: signal.inputText!,
        inputMeta: spec.inputMeta,
        expected: spec.expected,
        grader: spec.grader,
        origin: 'usage',
        originSignalId: signal.id,
        label: spec.label,
      })
      .returning({ id: evalCases.id });

    if (created) {
      await markPromoted(ctx, signal.id, created.id);
      result.created++;
      result.byTask[signal.task] = (result.byTask[signal.task] ?? 0) + 1;
    }
  }

  return result;
}

type CaseSpec = {
  expected: Record<string, unknown>;
  grader: Grader;
  label: string;
  inputMeta: Record<string, unknown>;
};

/**
 * Turn one signal into a gradeable expectation, or decline.
 *
 * Declining is the common path and that is correct — most signals are too
 * vague to assert anything about.
 */
function caseFor(signal: typeof feedbackSignals.$inferSelect): CaseSpec | null {
  const text = signal.inputText;
  if (!text || text.trim().length < 20) return null;

  const task = signal.task as LearningTask;
  // Extractors read this to decide whether the speaker is the customer, which
  // materially changes what they will fire on.
  const inputMeta: Record<string, unknown> = { isCustomer: true };

  const isExtraction =
    task === 'extract_commitments' ||
    task === 'extract_objections' ||
    task === 'extract_product_signals' ||
    task === 'extract_facts';

  if (isExtraction) {
    if (signal.verdict === 'negative') {
      // A human said there is nothing here. Over-firing is the most common and
      // most corrosive extraction failure, so these are the best cases we get.
      return {
        expected: {},
        grader: 'empty',
        label: `should not extract from: ${snippet(text)}`,
        inputMeta,
      };
    }

    if (signal.verdict === 'corrected') {
      const corrected = asRecord(signal.humanOutput);
      const category = typeof corrected?.['category'] === 'string' ? corrected['category'] : null;
      if (category) {
        return {
          expected: { category },
          grader: 'category',
          label: `should classify as ${category}: ${snippet(text)}`,
          inputMeta,
        };
      }
      const summary =
        typeof corrected?.['summary'] === 'string'
          ? corrected['summary']
          : typeof corrected?.['description'] === 'string'
            ? corrected['description']
            : null;
      if (summary) {
        return {
          expected: { contains: keyTerms(summary) },
          grader: 'contains',
          label: `should capture "${snippet(summary, 48)}"`,
          inputMeta,
        };
      }
      return null;
    }

    // Accepted unchanged: assert only that it still finds something. Asserting
    // the exact wording would make every harmless phrasing change a failure.
    return {
      expected: {},
      grader: 'non_empty',
      label: `should extract from: ${snippet(text)}`,
      inputMeta,
    };
  }

  if (task === 'draft_email') {
    const human = asRecord(signal.humanOutput);
    const body = typeof human?.['body'] === 'string' ? human['body'] : null;
    if (signal.verdict === 'corrected' && body) {
      return {
        expected: { contains: keyTerms(body).slice(0, 3) },
        grader: 'contains',
        label: `draft should mention ${keyTerms(body).slice(0, 3).join(', ')}`,
        inputMeta: {},
      };
    }
    return null;
  }

  if (task === 'answer_question') {
    if (signal.verdict === 'negative') return null; // "bad answer" is not yet an assertion
    const model = asRecord(signal.modelOutput);
    const answer = typeof model?.['answer'] === 'string' ? model['answer'] : null;
    if (signal.verdict === 'positive' && answer) {
      return {
        expected: {},
        grader: 'non_empty',
        label: `should still answer: ${snippet(text, 56)}`,
        inputMeta: {},
      };
    }
    return null;
  }

  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function snippet(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'they', 'have', 'will', 'would', 'about',
  'their', 'there', 'been', 'what', 'when', 'your', 'you', 'our', 'not', 'but', 'are', 'was',
  'can', 'has', 'his', 'her', 'its', 'all', 'any', 'out', 'who', 'how', 'per',
]);

/**
 * The words worth asserting on.
 *
 * Longest-first rather than first-seen: a distinctive noun is a far better
 * assertion than whichever short word happened to appear earliest.
 */
function keyTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words.sort((a, b) => b.length - a.length)) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }
  return unique.slice(0, 4);
}
