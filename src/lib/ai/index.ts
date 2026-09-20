import { env } from '@/lib/env';
import { AnthropicModel } from './providers/anthropic';
import { GoogleModel } from './providers/google';
import { LocalModel } from './providers/local';
import { OpenAiModel } from './providers/openai';
import type { EmbeddingModel, LanguageModel } from './types';
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
}

export function __setLanguageModel(model: LanguageModel): void {
  cachedModel = model;
}

export * from './types';
export { buildSystemPrompt, renderEvidence, sanitizeUntrusted, fitEvidence } from './prompt';
