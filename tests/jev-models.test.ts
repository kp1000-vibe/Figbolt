import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JEV_MODEL_ID } from '@/lib/ai/jev';
import type { RoutableModel, RoutingDecision } from '@/lib/ai/router';
import type { LanguageModel, StructuredRequest } from '@/lib/ai/types';

/**
 * Jev chooses the model — Claude, OpenAI or Gemini — for every AI call.
 *
 * tests/jev-router.test.ts pins the decision itself (never block, never guess,
 * never leak). This file pins what the decision *controls*:
 *
 *   - the catalogue: which models Jev is offered, and that a provider without
 *     a key is never one of them
 *   - control: every caller of getLanguageModel() goes through Jev, and the
 *     model Jev names is the provider whose API is actually called
 *   - failover: a chosen model that errors never leaves a question unanswered
 */

const ORIGINAL = { ...process.env };

const ANSWER: StructuredRequest<{ answer: string; confidence: number }> = {
  system: 'You are Bolt.',
  instruction: 'Which deals close this month?',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
    required: ['answer', 'confidence'],
  } as unknown as StructuredRequest<unknown>['schema'],
  task: 'answer_question',
};

function setEnv(vars: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL };
  for (const key of [
    'AI_PROVIDER',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'GOOGLE_API_KEY',
    'GOOGLE_MODEL',
    'JEV_ROUTER',
    'JEV_MODELS',
    'TYPESAFE_API_KEY',
    'MODEL_TIER_TINY',
    'MODEL_TIER_EVERYDAY',
    'MODEL_TIER_LARGE',
    'MODEL_TIER_HARDEST',
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
}

const ALL_KEYS = {
  AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-openai-test',
  GOOGLE_API_KEY: 'google-test',
  JEV_ROUTER: 'on',
  TYPESAFE_API_KEY: 'ts-test',
};

async function fresh() {
  vi.resetModules();
  const ai = await import('@/lib/ai');
  const catalogue = await import('@/lib/ai/catalogue');
  ai.__resetModels();
  return { ai, catalogue };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL };
});

/* ── The catalogue ─────────────────────────────────────────────────────────── */

describe('which models Jev is offered', () => {
  it('offers Claude, OpenAI and Gemini when all three keys are set', async () => {
    setEnv(ALL_KEYS);
    const { catalogue } = await fresh();
    const providers = new Set(catalogue.listCandidates().map((c) => c.provider));
    expect(providers).toEqual(new Set(['anthropic', 'openai', 'google']));
  });

  it('never offers a provider whose key is missing', async () => {
    setEnv({ ...ALL_KEYS, OPENAI_API_KEY: undefined, GOOGLE_API_KEY: undefined });
    const { catalogue } = await fresh();
    const candidates = catalogue.listCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.every((c) => c.provider === 'anthropic')).toBe(true);
  });

  it('adds a provider the moment its key is set, with no other change', async () => {
    setEnv({ ...ALL_KEYS, GOOGLE_API_KEY: undefined });
    let { catalogue } = await fresh();
    expect(catalogue.listCandidates().some((c) => c.provider === 'google')).toBe(false);

    setEnv(ALL_KEYS);
    ({ catalogue } = await fresh());
    expect(catalogue.listCandidates().some((c) => c.provider === 'google')).toBe(true);
  });

  it('describes each model by the job it suits, every option distinct', async () => {
    setEnv(ALL_KEYS);
    const { catalogue } = await fresh();
    const candidates = catalogue.listCandidates();

    const haiku = candidates.find((c) => c.modelId.startsWith('claude-haiku'))!;
    const gemini = candidates.find((c) => c.provider === 'google')!;
    expect(haiku.strength).toBe('tiny');
    expect(gemini.criteria).toMatch(/long context/i);
    expect(new Set(candidates.map((c) => c.criteria)).size).toBe(candidates.length);
    expect(new Set(candidates.map((c) => c.key)).size).toBe(candidates.length);
  });

  it('is ordered weakest to strongest', async () => {
    setEnv(ALL_KEYS);
    const { catalogue } = await fresh();
    const ranks = catalogue.listCandidates().map((c) => catalogue.STRENGTHS.indexOf(c.strength));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('takes an explicit list from JEV_MODELS, in either form', async () => {
    setEnv({ ...ALL_KEYS, JEV_MODELS: 'claude-opus-5.5, openai:gpt-4.1, gemini-2.5-flash, not-a-model' });
    const { catalogue } = await fresh();
    const ids = catalogue.listCandidates().map((c) => `${c.provider}:${c.modelId}`);
    // Dotted Claude ID normalised; the unrecognisable entry dropped.
    expect(ids.sort()).toEqual(['anthropic:claude-opus-5-5', 'google:gemini-2.5-flash', 'openai:gpt-4.1']);
  });

  it('keeps the legacy MODEL_TIER_* settings working, as model IDs or provider names', async () => {
    setEnv({
      ...ALL_KEYS,
      JEV_MODELS: undefined,
      OPENAI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      MODEL_TIER_TINY: 'claude-haiku-4-5-20251001',
      MODEL_TIER_LARGE: 'anthropic',
    });
    const { catalogue } = await fresh();
    const ids = catalogue.listCandidates().map((c) => c.modelId);
    expect(ids).toContain('claude-haiku-4-5-20251001');
    // No duplicates even though the tier settings repeat default models.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ── Control ───────────────────────────────────────────────────────────────── */

describe('Jev has control', () => {
  it('routes every getLanguageModel() caller when routing is on', async () => {
    setEnv(ALL_KEYS);
    const { ai } = await fresh();
    const { JevRoutedModel } = await import('@/lib/ai/routed');
    expect(ai.getLanguageModel()).toBeInstanceOf(JevRoutedModel);
  });

  it('steps aside when routing is off, without a Jev key, or with one model', async () => {
    const { JevRoutedModel } = await import('@/lib/ai/routed');

    setEnv({ ...ALL_KEYS, JEV_ROUTER: 'off' });
    let { ai } = await fresh();
    expect(ai.getLanguageModel()).not.toBeInstanceOf((await import('@/lib/ai/routed')).JevRoutedModel);

    setEnv({ ...ALL_KEYS, TYPESAFE_API_KEY: undefined });
    ({ ai } = await fresh());
    expect(ai.getLanguageModel().constructor.name).not.toBe(JevRoutedModel.name);

    setEnv({ ...ALL_KEYS, JEV_MODELS: 'claude-opus-5-5' });
    ({ ai } = await fresh());
    expect(ai.getLanguageModel().constructor.name).not.toBe(JevRoutedModel.name);
  });

  /**
   * End to end over the real adapters: a fake network where TypeSafe answers
   * with Jev's pick and each provider's endpoint answers in its own format.
   * Whichever model Jev names must be the API that gets called.
   */
  async function askWithJevPicking(pick: (keys: string[]) => string) {
    setEnv(ALL_KEYS);
    const { ai, catalogue } = await fresh();
    const keys = catalogue.listCandidates().map((c) => c.key);
    const chosenKey = pick(keys);
    const hits: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('typesafe.ai')) {
          hits.push('jev');
          return Response.json({
            model: JEV_MODEL_ID,
            answers: {
              model: { type: 'choice', choice: chosenKey, confidence: 0.93, probabilities: {} },
              stakes: { type: 'score', score: 0, confidence: 0.9, legend: {}, probabilities: {} },
            },
            usage: { input_tokens: 300, output_tokens: 10 },
          });
        }
        const args = { answer: 'Atlas and Acme', confidence: 0.8 };
        if (u.includes('anthropic.com')) {
          hits.push('anthropic');
          return Response.json({
            content: [{ type: 'tool_use', id: 't1', name: 'emit_result', input: args }],
            stop_reason: 'tool_use',
            usage: {},
          });
        }
        if (u.includes('openai.com')) {
          hits.push('openai');
          return Response.json({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify(args) } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {},
          });
        }
        if (u.includes('googleapis.com')) {
          hits.push('google');
          return Response.json({
            candidates: [{ content: { parts: [{ functionCall: { name: 'emit_result', args } }] } }],
            usageMetadata: {},
          });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const result = await ai.getLanguageModel().completeStructured(ANSWER);
    return { result, hits, chosenKey };
  }

  it('calls Gemini when Jev picks Gemini', async () => {
    const { result, hits } = await askWithJevPicking((keys) => keys.find((k) => k.startsWith('gemini'))!);
    expect(hits).toEqual(['jev', 'google']);
    expect(result.model).toMatch(/^gemini/);
    expect(result.routing?.decidedBy).toBe('jev');
  });

  it('calls OpenAI when Jev picks OpenAI', async () => {
    const { result, hits } = await askWithJevPicking((keys) => keys.find((k) => k.startsWith('gpt'))!);
    expect(hits).toEqual(['jev', 'openai']);
    expect(result.model).toMatch(/^gpt/);
  });

  it('calls Claude when Jev picks Claude', async () => {
    const { result, hits } = await askWithJevPicking((keys) => keys.find((k) => k.startsWith('claude_haiku'))!);
    expect(hits).toEqual(['jev', 'anthropic']);
    expect(result.model).toMatch(/^claude-haiku/);
  });

  it('runs the default, and says so, when Jev names a model it was not offered', async () => {
    const { result, hits } = await askWithJevPicking(() => 'some_model_jev_made_up');
    expect(hits).toEqual(['jev', 'anthropic']);
    expect(result.routing?.decidedBy).toBe('default');
    expect(result.routing?.reason).toBe('low_confidence');
  });
});

/* ── Failover ──────────────────────────────────────────────────────────────── */

describe('failover', () => {
  // Loaded together so `instanceof ModelError` in the router sees the same
  // class the test throws — other suites here reset the module registry.
  async function load() {
    vi.resetModules();
    const [{ JevRoutedModel }, { ModelError }] = await Promise.all([
      import('@/lib/ai/routed'),
      import('@/lib/ai/types'),
    ]);
    return { JevRoutedModel, ModelError };
  }

  function model(id: string, behaviour: () => Promise<never> | 'ok'): LanguageModel {
    const run = async () => {
      const r = behaviour();
      if (r !== 'ok') return r;
      return { value: { answer: id } as never, usage: { promptTokens: 0, completionTokens: 0 }, model: id, confidence: 1 };
    };
    return {
      id,
      provider: 'anthropic',
      isRemote: true,
      completeStructured: run as LanguageModel['completeStructured'],
      complete: async () => ({ text: id, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 }, model: id }),
    };
  }

  function routedTo(chosen: LanguageModel, fallback: LanguageModel) {
    const candidate = { key: chosen.id, provider: 'google', modelId: chosen.id, strength: 'large', criteria: 'x', model: chosen } as RoutableModel;
    const decision: RoutingDecision = {
      chosen: candidate,
      model: chosen,
      reason: 'jev',
      confidence: 0.9,
      stakes: 0,
      raisedForStakes: false,
      jevLatencyMs: 1,
      jevCostUsd: 0,
      fellBack: false,
    };
    return { candidates: [candidate, { ...candidate, key: 'other' }], route: vi.fn(async () => decision), fallback };
  }

  it('answers on the default when the model Jev chose has an outage', async () => {
    const { JevRoutedModel, ModelError } = await load();
    const down = model('gemini-2.5-pro', () => Promise.reject(new ModelError('Google 503', 'google', true)));
    const { candidates, route, fallback } = routedTo(down, model('claude-opus-5-5', () => 'ok'));

    const result = await new JevRoutedModel(candidates, fallback, route).completeStructured(ANSWER);

    expect(result.model).toBe('claude-opus-5-5');
    expect(result.routing?.failedOverFrom).toBe('gemini-2.5-pro');
  });

  it('does not hide a programming error behind a failover', async () => {
    const { JevRoutedModel } = await load();
    const buggy = model('gemini-2.5-pro', () => Promise.reject(new TypeError('x is undefined')));
    const { candidates, route, fallback } = routedTo(buggy, model('claude-opus-5-5', () => 'ok'));

    await expect(new JevRoutedModel(candidates, fallback, route).completeStructured(ANSWER)).rejects.toThrow(
      TypeError,
    );
  });

  it('surfaces the error when the default itself was the one that failed', async () => {
    const { JevRoutedModel, ModelError } = await load();
    const down = model('claude-opus-5-5', () => Promise.reject(new ModelError('Anthropic 529', 'anthropic', true)));
    const decision: RoutingDecision = {
      chosen: null, model: down, reason: 'low_confidence', confidence: 0.3, stakes: null,
      raisedForStakes: false, jevLatencyMs: 1, jevCostUsd: 0, fellBack: true,
    };
    const candidates = [
      { key: 'a', provider: 'anthropic', modelId: 'a', strength: 'tiny', criteria: 'a', model: down },
      { key: 'b', provider: 'anthropic', modelId: 'b', strength: 'hardest', criteria: 'b', model: down },
    ] as RoutableModel[];

    await expect(
      new JevRoutedModel(candidates, down, vi.fn(async () => decision)).completeStructured(ANSWER),
    ).rejects.toThrow(/529/);
  });
});
