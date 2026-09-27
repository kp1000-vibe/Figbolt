import { env } from '@/lib/env';
import { AnthropicModel } from './providers/anthropic';
import { GoogleModel } from './providers/google';
import { LocalModel } from './providers/local';
import { OpenAiModel } from './providers/openai';
import type { EmbeddingModel, LanguageModel, TaskKind, EvidenceItem } from './types';
import { routeTask, routerEnabled, TIERS, type Tier, type RoutingDecision } from './router';
import { LocalEmbeddingModel, OpenAiEmbeddingModel } from './embeddings';

/**
 * Model resolution.
 *
 * Falling back to the offline engine when a key is missing is deliberate: the
 * product must never be *broken* by a misconfigured provider, and a loud log
 * line beats a 500 on the Ask AI page. Set `AI_PROVIDER` explicitly to pin.
 */

let cachedModel: LanguageModel | undefined;
let cachedEmbedder: EmbeddingModel | undefined;
let warned = false;

export function getLanguageModel(): LanguageModel {
  if (cachedModel) return cachedModel;

  switch (env.AI_PROVIDER) {
    case 'anthropic':
      if (env.ANTHROPIC_API_KEY) {
        cachedModel = new AnthropicModel(env.ANTHROPIC_API_KEY);
        break;
      }
      cachedModel = fallback('ANTHROPIC_API_KEY');
      break;
    case 'openai':
      if (env.OPENAI_API_KEY) {
        cachedModel = new OpenAiModel(env.OPENAI_API_KEY);
        break;
      }
      cachedModel = fallback('OPENAI_API_KEY');
      break;
    case 'google':
      if (env.GOOGLE_API_KEY) {
        cachedModel = new GoogleModel(env.GOOGLE_API_KEY);
        break;
      }
      cachedModel = fallback('GOOGLE_API_KEY');
      break;
    default:
      cachedModel = new LocalModel();
  }
  return cachedModel;
}

function fallback(missingKey: string): LanguageModel {
  if (!warned) {
    console.warn(
      `[ai] AI_PROVIDER=${env.AI_PROVIDER} but ${missingKey} is not set. ` +
        'Using the offline engine — answers stay grounded but are extractive.',
    );
    warned = true;
  }
  return new LocalModel();
}

export function getEmbeddingModel(): EmbeddingModel {
  if (cachedEmbedder) return cachedEmbedder;
  cachedEmbedder =
    env.EMBEDDING_PROVIDER === 'openai' && env.OPENAI_API_KEY
      ? new OpenAiEmbeddingModel(env.OPENAI_API_KEY, env.EMBEDDING_DIMENSIONS)
      : new LocalEmbeddingModel(env.EMBEDDING_DIMENSIONS);
  return cachedEmbedder;
}

/** Test seam: drop cached singletons so a suite can install its own model. */
export function __resetModels(): void {
  cachedModel = undefined;
  cachedEmbedder = undefined;
  cachedTiers = undefined;
}

export function __setLanguageModel(model: LanguageModel): void {
  cachedModel = model;
}


/* ── Jev-routed model selection ────────────────────────────────────────────── */

/**
 * Build a model for a named provider, or null when its key is absent.
 *
 * Separate from `getLanguageModel` because the router needs several at once,
 * and a tier with no key must be skipped rather than silently become the
 * offline engine — that would make Jev's choice meaningless.
 */
function providerByName(name: string): LanguageModel | null {
  switch (name.trim().toLowerCase()) {
    case 'anthropic':
      return env.ANTHROPIC_API_KEY ? new AnthropicModel(env.ANTHROPIC_API_KEY) : null;
    case 'openai':
      return env.OPENAI_API_KEY ? new OpenAiModel(env.OPENAI_API_KEY) : null;
    case 'google':
      return env.GOOGLE_API_KEY ? new GoogleModel(env.GOOGLE_API_KEY) : null;
    case 'local':
      return new LocalModel();
    default:
      return null;
  }
}

let cachedTiers: Partial<Record<Tier, LanguageModel>> | undefined;

/** The models Jev may choose between, by tier. */
export function getTierModels(): Partial<Record<Tier, LanguageModel>> {
  if (cachedTiers) return cachedTiers;

  const configured: Record<Tier, string | undefined> = {
    tiny: env.MODEL_TIER_TINY,
    everyday: env.MODEL_TIER_EVERYDAY,
    large: env.MODEL_TIER_LARGE,
    hardest: env.MODEL_TIER_HARDEST,
  };

  const out: Partial<Record<Tier, LanguageModel>> = {};
  for (const tier of TIERS) {
    const name = configured[tier];
    if (!name) continue;
    const model = providerByName(name);
    if (model) out[tier] = model;
    else console.warn(`[ai] MODEL_TIER_${tier.toUpperCase()}=${name} has no usable key; tier skipped`);
  }

  cachedTiers = out;
  return out;
}

/**
 * The model for one job, with Jev deciding.
 *
 * Every AI call site can adopt this by awaiting it instead of calling
 * `getLanguageModel()`. When the router is off, Jev is unreachable, or fewer
 * than two tiers are configured, it returns exactly what
 * `getLanguageModel()` would have — so adopting it is never a behaviour
 * change in the default configuration.
 */
export async function getModelForTask(request: {
  task: TaskKind;
  instruction?: string;
  evidence?: EvidenceItem[];
  expectsProse?: boolean;
}): Promise<{ model: LanguageModel; routing: RoutingDecision }> {
  const fallbackModel = getLanguageModel();
  const routing = await routeTask(request, getTierModels(), fallbackModel);
  return { model: routing.model, routing };
}

export { routerEnabled, TIERS };
export type { Tier, RoutingDecision };

export * from './types';
export { buildSystemPrompt, renderEvidence, sanitizeUntrusted, fitEvidence } from './prompt';
