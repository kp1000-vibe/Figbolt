import { env } from '@/lib/env';
import { AnthropicModel } from './providers/anthropic';
import { GoogleModel } from './providers/google';
import { LocalModel } from './providers/local';
import { OpenAiModel } from './providers/openai';
import type { EmbeddingModel, LanguageModel, TaskKind, EvidenceItem } from './types';
import { routeTask, routerEnabled, TIERS, type Tier, type RoutingDecision, type RoutableModel } from './router';
import { listCandidates, modelFor } from './catalogue';
import { jevConfigured } from './jev';
import { JevRoutedModel } from './routed';
import { LocalEmbeddingModel, OpenAiEmbeddingModel } from './embeddings';

/**
 * Model resolution.
 *
 * With JEV_ROUTER=on, a Jev key, and at least two models to choose between,
 * every caller gets the Jev-routed model: Jev picks Claude, OpenAI or Gemini
 * per call. Otherwise — or whenever Jev does not make the call — the default
 * below runs.
 *
 * Falling back to the offline engine when a key is missing is deliberate: the
 * product must never be *broken* by a misconfigured provider, and a loud log
 * line beats a 500 on the Ask AI page. Set `AI_PROVIDER` explicitly to pin.
 */

let cachedModel: LanguageModel | undefined;
let cachedDefault: LanguageModel | undefined;
let cachedEmbedder: EmbeddingModel | undefined;
let warned = false;

export function getLanguageModel(): LanguageModel {
  if (cachedModel) return cachedModel;

  const candidates = routerEnabled() && jevConfigured() ? getCandidateModels() : [];
  cachedModel =
    candidates.length >= 2 ? new JevRoutedModel(candidates, getDefaultModel()) : getDefaultModel();
  return cachedModel;
}

/**
 * The model that runs whenever Jev does not decide: the provider named by
 * AI_PROVIDER. Also the failover when a Jev-chosen model errors.
 */
export function getDefaultModel(): LanguageModel {
  if (cachedDefault) return cachedDefault;
  cachedDefault = resolveDefault();
  return cachedDefault;
}

function resolveDefault(): LanguageModel {
  let model: LanguageModel;

  switch (env.AI_PROVIDER) {
    case 'anthropic':
      if (env.ANTHROPIC_API_KEY) {
        model = new AnthropicModel(env.ANTHROPIC_API_KEY);
        break;
      }
      model = fallback('ANTHROPIC_API_KEY');
      break;
    case 'openai':
      if (env.OPENAI_API_KEY) {
        model = new OpenAiModel(env.OPENAI_API_KEY);
        break;
      }
      model = fallback('OPENAI_API_KEY');
      break;
    case 'google':
      if (env.GOOGLE_API_KEY) {
        model = new GoogleModel(env.GOOGLE_API_KEY);
        break;
      }
      model = fallback('GOOGLE_API_KEY');
      break;
    default:
      model = new LocalModel();
  }
  return model;
}

let cachedCandidates: RoutableModel[] | undefined;

/** The models Jev may choose between, each ready to run. */
export function getCandidateModels(): RoutableModel[] {
  if (cachedCandidates) return cachedCandidates;
  cachedCandidates = listCandidates().map((c) => ({ ...c, model: modelFor(c) }));
  return cachedCandidates;
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
  cachedDefault = undefined;
  cachedEmbedder = undefined;
  cachedCandidates = undefined;
}

export function __setLanguageModel(model: LanguageModel): void {
  cachedModel = model;
}


/* ── Jev-routed model selection ────────────────────────────────────────────── */

/**
 * The model for one multi-step job, with Jev deciding once for the whole job.
 *
 * Ordinary calls need nothing from this: getLanguageModel() already routes
 * every call. A multi-step loop (an agent run) should decide once and keep
 * that model, so a conversation and its tool calls do not change provider
 * halfway through.
 */
export async function getModelForTask(request: {
  task?: TaskKind;
  instruction?: string;
  evidence?: EvidenceItem[];
  expectsProse?: boolean;
  usesTools?: boolean;
}): Promise<{ model: LanguageModel; routing: RoutingDecision }> {
  const model = getLanguageModel();
  const routing =
    model instanceof JevRoutedModel
      ? await model.decide(request)
      : await routeTask(request, [], getDefaultModel());
  return { model: routing.model, routing };
}

export { routerEnabled, TIERS };
export type { Tier, RoutingDecision };

export * from './types';
export { buildSystemPrompt, renderEvidence, sanitizeUntrusted, fitEvidence } from './prompt';
