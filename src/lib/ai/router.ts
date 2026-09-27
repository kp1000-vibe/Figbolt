import { env } from '@/lib/env';
import { askJev, confidentChoice, jevConfigured, JEV_CONFIDENCE_FLOOR, type JevQuestion } from './jev';
import type { EvidenceItem, LanguageModel, TaskKind } from './types';

/**
 * Jev decides which model does the work.
 *
 * Most of what a CRM asks a model to do is small. Classifying an intent,
 * suggesting a stage, deciding whether a sentence is a commitment — these do
 * not need the largest model, and paying Fable prices for them is how AI
 * budgets get burned with nothing to show. Jev sizes each job in about a third
 * of a second for a rounding error, and the work goes to the smallest model
 * that can do it well.
 *
 * Four tiers, smallest first, matched to whichever providers are actually
 * configured. With only one provider configured there is nothing to route
 * between and the router stays out of the way.
 *
 * Three things this must never do, in priority order:
 *
 *   1. **Never block.** Jev slow, missing, erroring or switched off is
 *      indistinguishable from the router not existing.
 *   2. **Never guess.** Below 0.6 confidence the default model runs, per
 *      TypeSafe's own guidance. A confident wrong tier is worse than no tier.
 *   3. **Never leak.** By default Jev is sent a *description* of the job — its
 *      kind, its size, its shape — and not the customer's words. Figbolt's
 *      whole trust model treats customer email and transcripts as sensitive;
 *      shipping them to a third party to decide a routing question would trade
 *      that away for a fraction of a cent. Set JEV_SEND_CONTENT=true to opt in.
 */

export const TIERS = ['tiny', 'everyday', 'large', 'hardest'] as const;
export type Tier = (typeof TIERS)[number];

const TIER_GUIDE: Record<Tier, string> = {
  tiny: 'a lookup, a rename, a one-line answer, a yes/no classification',
  everyday: 'a normal email, a short summary, a routine extraction',
  large: 'a multi-step build, research across many records, a full report',
  hardest: 'strategy, or anything where a wrong call is expensive to undo',
};

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

  const question: JevQuestion = {
    id: 'tier',
    kind: 'choice',
    question:
      'What is the smallest model tier that can do this job well? ' +
      configuredTiers.map((t) => `${t} = ${TIER_GUIDE[t]}`).join('; '),
    options: [...configuredTiers],
  };

  const result = await askJev(describeJob(request), [question]);
  if (!result) return { ...base, tier: 'everyday', reason: 'jev_unavailable' };

  const chosen = confidentChoice(result, 'tier', configuredTiers);
  if (!chosen) {
    // Jev answered but is not sure enough. Its own guidance says the caller
    // decides, and the caller's default is the safest thing in the room.
    return {
      ...base,
      tier: 'everyday',
      reason: 'low_confidence',
      confidence: result.answers['tier']?.confidence ?? null,
      jevLatencyMs: result.latencyMs,
      jevCostUsd: result.costUsd,
    };
  }

  const tier = chosen.value as Tier;
  return {
    tier,
    model: resolveTier(tier, available, defaultModel),
    reason: 'jev',
    confidence: chosen.confidence,
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
 * a job — the difference between a one-line classification and a full report
 * is structural, not semantic.
 */
export function describeJob(request: RouteRequest): string {
  const evidence = request.evidence ?? [];
  const totalChars = evidence.reduce((n, e) => n + e.content.length, 0);
  const untrusted = evidence.filter((e) => e.trust === 'untrusted').length;

  const lines = [
    `Job: ${request.task.replace(/_/g, ' ')}`,
    `Evidence items: ${evidence.length}`,
    `Evidence size: ${totalChars} characters`,
    `Untrusted sources among them: ${untrusted}`,
    `Expects a written answer: ${request.expectsProse ? 'yes' : 'no'}`,
    `Judgement-heavy task: ${INHERENTLY_HARD.has(request.task) ? 'yes' : 'no'}`,
  ];

  if (env.JEV_SEND_CONTENT) {
    // Opt-in. Even then, only the operator's own instruction goes — never the
    // retrieved customer content, which is the sensitive half.
    if (request.instruction) lines.push('', `Request: ${request.instruction.slice(0, 2000)}`);
  } else if (request.instruction) {
    lines.push(`Request length: ${request.instruction.length} characters`);
  }

  return lines.join('\n');
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
