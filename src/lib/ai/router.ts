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
import type { EvidenceItem, LanguageModel, TaskKind } from './types';

/**
 * Jev decides which model does the work.
 *
 * Most of what a CRM asks a model to do is small. Classifying an intent,
 * suggesting a stage, deciding whether a sentence is a commitment — these do
 * not need the largest model, and paying frontier prices for them is how AI
 * budgets get burned with nothing to show. Jev sizes each job in a fraction of
 * a second for a rounding error, and the work goes to the smallest model that
 * can do it well.
 *
 * This follows TypeSafe's intent-routing pattern: one call, two independent
 * questions over the same state — which tier, and how expensive a wrong answer
 * is — with code, not the model, owning the policy that combines them.
 *
 * Four tiers, smallest first, matched to whichever providers are actually
 * configured. With fewer than two tiers configured there is nothing to route
 * between and the router stays out of the way.
 *
 * Three things this must never do, in priority order:
 *
 *   1. **Never block.** Jev slow, missing, erroring or switched off is
 *      indistinguishable from the router not existing.
 *   2. **Never guess.** Below the confidence floor the default model runs. A
 *      confident wrong tier is recoverable; an unsure one is a coin toss.
 *   3. **Never leak.** By default Jev is sent a *description* of the job — its
 *      kind, its size, its shape — and not the customer's words. Figbolt's
 *      whole trust model treats customer email and transcripts as sensitive;
 *      shipping them to a third party to decide a routing question would trade
 *      that away for a fraction of a cent. Set JEV_SEND_CONTENT=true to opt in.
 */

export const TIERS = ['tiny', 'everyday', 'large', 'hardest'] as const;
export type Tier = (typeof TIERS)[number];

/** Option descriptions belong in criteria, not crammed into the instructions. */
const TIER_CRITERIA: Record<Tier, string> = {
  tiny: 'A lookup, a rename, a one-line answer, or a yes/no classification.',
  everyday: 'A normal email, a short summary, or a routine extraction.',
  large: 'A multi-step build, research across many records, or a full report.',
  hardest: 'Strategy, or anything where a wrong call is expensive to undo.',
};

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

export type RoutingDecision = {
  tier: Tier;
  /** The model that will run the job. */
  model: LanguageModel;
  /** Why this model: Jev's call, or the reason we did not use one. */
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
  /** True when policy moved the job up a tier because the stakes were high. */
  raisedForStakes: boolean;
  jevLatencyMs: number | null;
  jevCostUsd: number | null;
  /** True when the default model ran instead of a Jev-chosen one. */
  fellBack: boolean;
};

export type RouteRequest = {
  task: TaskKind;
  /** The user's own words, when there are any. Never a customer's. */
  instruction?: string;
  evidence?: EvidenceItem[];
  /** Hint that the caller expects a long, composed answer. */
  expectsProse?: boolean;
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
 * Ask Jev which tier this job needs, then resolve that to a model.
 *
 * `available` maps a tier to a model. Tiers with no model fall to the nearest
 * smaller one that has a model, so a workspace with two providers routes
 * between two rather than failing.
 */
export async function routeTask(
  request: RouteRequest,
  available: Partial<Record<Tier, LanguageModel>>,
  defaultModel: LanguageModel,
): Promise<RoutingDecision> {
  const base = {
    model: defaultModel,
    confidence: null,
    stakes: null,
    raisedForStakes: false,
    jevLatencyMs: null,
    jevCostUsd: null,
    fellBack: true,
  } as const;

  const configuredTiers = TIERS.filter((t) => available[t]);
  if (configuredTiers.length < 2) {
    return { ...base, tier: 'everyday', reason: 'single_model' };
  }
  if (!routerEnabled()) return { ...base, tier: 'everyday', reason: 'router_off' };
  if (!jevConfigured()) return { ...base, tier: 'everyday', reason: 'jev_not_configured' };

  const options: Record<string, string> = {};
  for (const tier of configuredTiers) options[tier] = TIER_CRITERIA[tier];

  const questions: JevQuestions = {
    // Two independent judgements over one state, answered in parallel.
    tier: choice(
      'Which is the smallest model tier that can do this job well? Judge from the ' +
        'kind of work, how much evidence there is, and whether a written answer is expected.',
      options,
    ),
    stakes: score('If the model gets this job wrong, how much does it cost?', STAKES_LEVELS),
  };

  const result = await askJev(describeJob(request), questions);
  if (!result) return { ...base, tier: 'everyday', reason: 'jev_unavailable' };

  const stakes = confidentScore(result, 'stakes');
  const chosen = confidentChoice(result, 'tier', configuredTiers);

  if (!chosen) {
    // Jev answered but is not sure enough. The caller's default is the safest
    // thing in the room, so it wins.
    const answer = result.answers['tier'];
    return {
      ...base,
      tier: 'everyday',
      reason: 'low_confidence',
      confidence: answer?.type === 'choice' ? answer.confidence : null,
      stakes: stakes?.level ?? null,
      jevLatencyMs: result.latencyMs,
      jevCostUsd: result.costUsd,
    };
  }

  // Policy lives here, not in the prompt: raw judgements stay reusable and
  // this rule can change without re-running inference.
  const picked = chosen.value as Tier;
  const raise = stakes !== null && stakes.level >= STAKES_ESCALATE_AT;
  const tier = raise ? nextTierUp(picked, configuredTiers) : picked;

  return {
    tier,
    model: resolveTier(tier, available, defaultModel),
    reason: 'jev',
    confidence: chosen.confidence,
    stakes: stakes?.level ?? null,
    raisedForStakes: tier !== picked,
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
 * whether any of it is untrusted, and roughly how long. That is enough to size
 * a job — the difference between a one-line classification and a full report is
 * structural, not semantic.
 *
 * Named fields rather than a paragraph, per TypeSafe's guidance on state with
 * several parts.
 */
export function describeJob(request: RouteRequest): JevState {
  const evidence = request.evidence ?? [];
  const totalChars = evidence.reduce((n, e) => n + e.content.length, 0);

  const state: Record<string, unknown> = {
    job: request.task.replace(/_/g, ' '),
    evidence_items: evidence.length,
    evidence_characters: totalChars,
    untrusted_sources: evidence.filter((e) => e.trust === 'untrusted').length,
    expects_written_answer: Boolean(request.expectsProse),
    judgement_heavy_task: INHERENTLY_HARD.has(request.task),
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

/** One tier larger among those configured, or the same tier if already top. */
function nextTierUp(tier: Tier, configured: readonly Tier[]): Tier {
  const bigger = configured.filter((t) => TIERS.indexOf(t) > TIERS.indexOf(tier));
  return bigger[0] ?? tier;
}

/** Nearest configured model at or below the chosen tier. */
function resolveTier(
  tier: Tier,
  available: Partial<Record<Tier, LanguageModel>>,
  fallbackModel: LanguageModel,
): LanguageModel {
  const index = TIERS.indexOf(tier);
  for (let i = index; i >= 0; i--) {
    const candidate = available[TIERS[i]!];
    if (candidate) return candidate;
  }
  for (let i = index + 1; i < TIERS.length; i++) {
    const candidate = available[TIERS[i]!];
    if (candidate) return candidate;
  }
  return fallbackModel;
}

export { JEV_CONFIDENCE_FLOOR };
