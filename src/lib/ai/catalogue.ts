import { env } from '@/lib/env';
import { AnthropicModel, normalizeAnthropicModelId } from './providers/anthropic';
import { GoogleModel } from './providers/google';
import { OpenAiModel } from './providers/openai';
import type { LanguageModel } from './types';

/**
 * The models Jev chooses between — across Claude, OpenAI and Gemini.
 *
 * Each candidate carries a plain statement of when it is the right pick. That
 * statement is what Jev reads (it becomes the option's criteria), so it
 * describes the *job* a model suits, never marketing.
 *
 * A model is a candidate only when its provider's key is configured. Offering
 * Jev a model that cannot run would make its choice unusable, so a provider
 * with no key is simply absent — add the key and its models join the next
 * decision, no other change needed.
 */

export const STRENGTHS = ['tiny', 'everyday', 'large', 'hardest'] as const;
export type Strength = (typeof STRENGTHS)[number];

export type Provider = 'anthropic' | 'openai' | 'google';

export type ModelCandidate = {
  /** The option key Jev answers with. Stable, and safe as a JSON key. */
  key: string;
  provider: Provider;
  modelId: string;
  /** Where it sits for the stakes policy, which escalates to a stronger one. */
  strength: Strength;
  /** When Jev should pick it. */
  criteria: string;
};

/**
 * What each model family is for. Matched by pattern, first match wins, so a
 * new release in a known family is described correctly without a code change.
 */
const PROFILES: { match: RegExp; strength: Strength; criteria: string }[] = [
  {
    match: /^claude-haiku/,
    strength: 'tiny',
    criteria:
      'Fastest and cheapest. Short, simple jobs: classify a sentence, pick a stage, a yes/no, a one-line answer.',
  },
  {
    match: /^claude-sonnet/,
    strength: 'everyday',
    criteria:
      'Strong all-rounder at moderate cost. Writing a customer email, summarising an account or meeting, routine extraction.',
  },
  {
    match: /^claude-opus/,
    strength: 'hardest',
    criteria:
      'Strongest reasoning; slowest and most expensive. Strategy, judgement-heavy analysis, anything costly to get wrong.',
  },
  {
    match: /^gemini-.*(flash|lite)/,
    strength: 'tiny',
    criteria: 'Fast and cheap with a very long context. Simple jobs over a large amount of text.',
  },
  {
    match: /^gemini-/,
    strength: 'large',
    criteria:
      'Very long context. Jobs that must read a large amount of evidence at once: many emails or full transcripts together.',
  },
  {
    match: /^(gpt-.*(mini|nano)|o\d+-mini)/,
    strength: 'tiny',
    criteria: 'Fast and cheap. Short structured jobs: classification and simple extraction.',
  },
  {
    match: /^(gpt-|o\d+|chatgpt-)/,
    strength: 'large',
    criteria:
      'General-purpose and dependable at structured output. Multi-field extraction and multi-step tool use.',
  },
];

/** The default Claude line-up, smallest first; the Opus slot follows ANTHROPIC_MODEL. */
const DEFAULT_CLAUDE = ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'] as const;

export function inferProvider(modelId: string): Provider | null {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gemini-')) return 'google';
  if (/^(gpt-|o\d+|chatgpt-)/.test(id)) return 'openai';
  return null;
}

function defaultModelFor(provider: Provider): string {
  if (provider === 'anthropic') return normalizeAnthropicModelId(env.ANTHROPIC_MODEL);
  if (provider === 'openai') return env.OPENAI_MODEL;
  return env.GOOGLE_MODEL;
}

/**
 * Parse one entry: `model-id`, `provider:model-id`, or a bare provider name
 * (the legacy MODEL_TIER_* form), which means that provider's default model.
 */
export function parseEntry(entry: string): { provider: Provider; modelId: string } | null {
  const raw = entry.trim();
  if (!raw) return null;

  const colon = raw.indexOf(':');
  if (colon > 0) {
    const provider = raw.slice(0, colon).trim().toLowerCase();
    const modelId = raw.slice(colon + 1).trim();
    if ((provider === 'anthropic' || provider === 'openai' || provider === 'google') && modelId) {
      return { provider, modelId: provider === 'anthropic' ? normalizeAnthropicModelId(modelId) : modelId };
    }
    return null;
  }

  const lower = raw.toLowerCase();
  if (lower === 'anthropic' || lower === 'openai' || lower === 'google') {
    return { provider: lower, modelId: defaultModelFor(lower) };
  }

  const provider = inferProvider(raw);
  if (!provider) return null;
  return { provider, modelId: provider === 'anthropic' ? normalizeAnthropicModelId(raw) : raw };
}

function keyFor(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function hasKey(provider: Provider): boolean {
  if (provider === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(env.OPENAI_API_KEY);
  return Boolean(env.GOOGLE_API_KEY);
}

/** The entries to consider, before key filtering. */
function configuredEntries(): string[] {
  if (env.JEV_MODELS) return env.JEV_MODELS.split(',');

  return [
    ...DEFAULT_CLAUDE,
    `anthropic:${env.ANTHROPIC_MODEL}`,
    `openai:${env.OPENAI_MODEL}`,
    `google:${env.GOOGLE_MODEL}`,
    // Legacy tier settings still contribute their models.
    env.MODEL_TIER_TINY,
    env.MODEL_TIER_EVERYDAY,
    env.MODEL_TIER_LARGE,
    env.MODEL_TIER_HARDEST,
  ].filter((e): e is string => Boolean(e));
}

/**
 * The candidates Jev may choose between: configured, deduplicated, and only
 * for providers whose key is present. Ordered weakest to strongest, so the
 * option list Jev sees reads in a sensible order.
 */
export function listCandidates(): ModelCandidate[] {
  const seen = new Set<string>();
  const out: ModelCandidate[] = [];

  for (const entry of configuredEntries()) {
    const parsed = parseEntry(entry);
    if (!parsed || !hasKey(parsed.provider)) continue;

    const key = keyFor(parsed.modelId);
    if (seen.has(key)) continue;
    seen.add(key);

    const profile = PROFILES.find((p) => p.match.test(parsed.modelId.toLowerCase()));
    out.push({
      key,
      provider: parsed.provider,
      modelId: parsed.modelId,
      strength: profile?.strength ?? 'everyday',
      criteria: profile?.criteria ?? `General-purpose ${parsed.provider} model.`,
    });
  }

  // Two candidates with identical criteria would be indistinguishable to Jev;
  // name the model in the later ones so every option says something different.
  const used = new Set<string>();
  for (const c of out) {
    if (used.has(c.criteria)) c.criteria = `${c.criteria} (${c.modelId})`;
    used.add(c.criteria);
  }

  return out.sort((a, b) => STRENGTHS.indexOf(a.strength) - STRENGTHS.indexOf(b.strength));
}

/** A runnable model for a candidate. Only called for candidates with a key. */
export function modelFor(candidate: ModelCandidate): LanguageModel {
  switch (candidate.provider) {
    case 'anthropic':
      return new AnthropicModel(env.ANTHROPIC_API_KEY!, candidate.modelId);
    case 'openai':
      return new OpenAiModel(env.OPENAI_API_KEY!, candidate.modelId);
    case 'google':
      return new GoogleModel(env.GOOGLE_API_KEY!, candidate.modelId);
  }
}
