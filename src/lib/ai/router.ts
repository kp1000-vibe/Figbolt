import { env } from '@/lib/env';
import {
  askJev,
  choice,
  confidentChoice,
  confidentScore,
  jevConfigured,
  score,
  JEV_CONFIDENCE_FLOOR,
  type JevQuestions,
  type JevState,
} from './jev';
import { STRENGTHS, type ModelCandidate } from './catalogue';
import type { EvidenceItem, LanguageModel, TaskKind } from './types';

/**
 * Jev decides which model does the work — Claude, OpenAI or Gemini.
 *
 * Most of what a CRM asks a model to do is small. Classifying an intent,
 * suggesting a stage, deciding whether a sentence is a commitment — these do
 * not need the largest model, and paying frontier prices for them is how AI
 * budgets get burned with nothing to show. Equally, some jobs suit one
 * provider better than another: a long-context model for a pile of
 * transcripts, the strongest reasoner for strategy. Jev reads a description of
 * each job and picks the model, by name, from whatever is configured.
 *
 * This follows TypeSafe's intent-routing pattern: one call, two independent
 * questions over the same state — which model, and how expensive a wrong
 * answer is — with code, not the model, owning the policy that combines them.
 *
 * Three things this must never do, in priority order:
 *
 *   1. **Never block.** Jev slow, missing, erroring or switched off is
 *      indistinguishable from the router not existing.
 *   2. **Never guess.** Below the confidence floor, code makes the call: the
 *      default model runs. A confident wrong pick is recoverable; an unsure
 *      one is a coin toss.
 *   3. **Never leak.** By default Jev is sent a *description* of the job — its
 *      kind, its size, its shape — and not the customer's words. Figbolt's
 *      whole trust model treats customer email and transcripts as sensitive;
 *      shipping them to a third party to decide a routing question would trade
 *      that away for a fraction of a cent. Set JEV_SEND_CONTENT=true to opt in.
 */

/** Kept for the vocabulary: the candidate strengths, weakest first. */
export const TIERS = STRENGTHS;
export type Tier = (typeof STRENGTHS)[number];

/**
 * What a wrong answer costs. Ordered levels, each a concrete situation, so the
 * score is a position on a real dimension rather than a vague severity.
 */
const STAKES_LEVELS = [
  'A wrong answer is immediately obvious and costs the user a moment to redo.',
  'A wrong answer looks plausible and could be relied on before anyone checks it.',
  'A wrong answer would reach a customer, or change a record, before a human reviews it.',
] as const;

/** The level at which we would rather overspend than be wrong. */
const STAKES_ESCALATE_AT = STAKES_LEVELS.length - 1;

/** A candidate with the model that runs it. */
export type RoutableModel = ModelCandidate & { model: LanguageModel };

export type RoutingDecision = {
  /** The candidate that will run the job, or null when the default runs. */
  chosen: RoutableModel | null;
  /** The model that will run the job. */
  model: LanguageModel;
  /** Why this model: Jev's call, or the reason code made it instead. */
  reason:
    | 'jev'
    | 'router_off'
    | 'jev_not_configured'
    | 'jev_unavailable'
    | 'low_confidence'
    | 'single_model';
  confidence: number | null;
  /** Jev's read on what a wrong answer costs, 0-based across STAKES_LEVELS. */
  stakes: number | null;
  /** True when policy moved the job to a stronger model because the stakes were high. */
  raisedForStakes: boolean;
  jevLatencyMs: number | null;
  jevCostUsd: number | null;
  /** True when the default model ran instead of a Jev-chosen one. */
  fellBack: boolean;
};

export type RouteRequest = {
  /** Absent for general-purpose calls that are not one of the named jobs. */
  task?: TaskKind;
  /** The user's own words, when there are any. Never a customer's. */
  instruction?: string;
  evidence?: EvidenceItem[];
  /** Hint that the caller expects a long, composed answer. */
  expectsProse?: boolean;
  /** True when the job calls tools over several steps (agents). */
  usesTools?: boolean;
};

/** Tasks whose cost is dominated by judgement, not volume. */
const INHERENTLY_HARD: ReadonlySet<TaskKind> = new Set([
  'generate_insights',
  'build_icp',
  'plan_agent',
  'compile_agent',
]);

export function routerEnabled(): boolean {
  return env.JEV_ROUTER === 'on';
}

/**
 * Ask Jev which model should run this job.
 *
 * `candidates` are the models that can actually run — see listCandidates().
 * `defaultModel` is what runs whenever Jev does not make the call.
 */
export async function routeTask(
  request: RouteRequest,
  candidates: readonly RoutableModel[],
  defaultModel: LanguageModel,
): Promise<RoutingDecision> {
  const base = {
    chosen: null,
    model: defaultModel,
    confidence: null,
    stakes: null,
    raisedForStakes: false,
    jevLatencyMs: null,
    jevCostUsd: null,
    fellBack: true,
  } as const;

  if (candidates.length < 2) return { ...base, reason: 'single_model' };
  if (!routerEnabled()) return { ...base, reason: 'router_off' };
  if (!jevConfigured()) return { ...base, reason: 'jev_not_configured' };

  const options: Record<string, string> = {};
  for (const c of candidates) options[c.key] = c.criteria;

  const questions: JevQuestions = {
    // Two independent judgements over one state, answered in parallel.
    model: choice(
      'Which model should do this job? Pick the cheapest one that will do it well. Judge from ' +
        'the kind of work, how much evidence there is, whether a written answer is expected, ' +
        'and whether it calls tools over several steps.',
      options,
    ),
    stakes: score('If the model gets this job wrong, how much does it cost?', STAKES_LEVELS),
  };

  const result = await askJev(describeJob(request), questions);
  if (!result) return { ...base, reason: 'jev_unavailable' };

  const stakes = confidentScore(result, 'stakes');
  const picked = confidentChoice(
    result,
    'model',
    candidates.map((c) => c.key),
  );

  if (!picked) {
    // Jev answered but is not sure enough, or named something it was not
    // offered. Code makes the call: the default is the safest thing in the room.
    const answer = result.answers['model'];
    return {
      ...base,
      reason: 'low_confidence',
      confidence: answer?.type === 'choice' ? answer.confidence : null,
      stakes: stakes?.level ?? null,
      jevLatencyMs: result.latencyMs,
      jevCostUsd: result.costUsd,
    };
  }

  // Policy lives here, not in the prompt: raw judgements stay reusable and
  // this rule can change without re-running inference.
  const first = candidates.find((c) => c.key === picked.value)!;
  const raise = stakes !== null && stakes.level >= STAKES_ESCALATE_AT;
  const chosen = raise ? strongerThan(first, candidates) : first;

  return {
    chosen,
    model: chosen.model,
    reason: 'jev',
    confidence: picked.confidence,
    stakes: stakes?.level ?? null,
    raisedForStakes: chosen !== first,
    jevLatencyMs: result.latencyMs,
    jevCostUsd: result.costUsd,
    fellBack: false,
  };
}

/**
 * The state Jev reasons over.
 *
 * This is the privacy boundary. By default it describes the job without
 * quoting the material: what kind of work it is, how much evidence there is,
 * whether any of it is untrusted, and roughly how long. That is enough to pick
 * a model — the difference between a one-line classification and a full report
 * is structural, not semantic.
 *
 * Named fields rather than a paragraph, per TypeSafe's guidance on state with
 * several parts.
 */
export function describeJob(request: RouteRequest): JevState {
  const evidence = request.evidence ?? [];
  const totalChars = evidence.reduce((n, e) => n + e.content.length, 0);

  const state: Record<string, unknown> = {
    job: request.task ? request.task.replace(/_/g, ' ') : 'general request',
    evidence_items: evidence.length,
    evidence_characters: totalChars,
    untrusted_sources: evidence.filter((e) => e.trust === 'untrusted').length,
    expects_written_answer: Boolean(request.expectsProse),
    multi_step_tool_use: Boolean(request.usesTools),
    judgement_heavy_task: request.task ? INHERENTLY_HARD.has(request.task) : false,
  };

  if (env.JEV_SEND_CONTENT) {
    // Opt-in. Even then, only the operator's own instruction goes — never the
    // retrieved customer content, which is the sensitive half.
    if (request.instruction) state['request'] = request.instruction.slice(0, 2000);
  } else if (request.instruction) {
    state['request_characters'] = request.instruction.length;
  }

  return state;
}

/**
 * The next stronger candidate, for high-stakes jobs: the weakest model that is
 * stronger than Jev's pick, preferring the same provider. Unchanged when the
 * pick is already the strongest.
 */
function strongerThan(pick: RoutableModel, candidates: readonly RoutableModel[]): RoutableModel {
  const rank = (c: ModelCandidate) => STRENGTHS.indexOf(c.strength);
  const stronger = candidates.filter((c) => rank(c) > rank(pick));
  if (stronger.length === 0) return pick;
  const nextRank = Math.min(...stronger.map(rank));
  const atNext = stronger.filter((c) => rank(c) === nextRank);
  return atNext.find((c) => c.provider === pick.provider) ?? atNext[0]!;
}

export { JEV_CONFIDENCE_FLOOR };
