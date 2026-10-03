import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetJevWarnings,
  choice,
  confidentChoice,
  confidentScore,
  likely,
  noul,
  score,
  JEV_CONFIDENCE_FLOOR,
  JEV_MODEL_ID,
  type JevResult,
} from '@/lib/ai/jev';
import { describeJob, routeTask, TIERS, type RoutableModel, type Tier } from '@/lib/ai/router';
import type { EvidenceItem, LanguageModel } from '@/lib/ai/types';

/**
 * Jev as the decision maker for model selection.
 *
 * Three properties matter more than the routing itself, and each of them is a
 * way the feature could quietly make the product worse:
 *
 *   never block  — a router that can stall the CRM is worse than none
 *   never guess  — an unsure answer is treated as no answer
 *   never leak   — customer email and transcripts must not reach a third
 *                  party to settle a routing question
 *
 * A fourth thing these tests pin down: the wire format. The first version of
 * this client was written against a guess at the API and every field name was
 * wrong. The contract at https://docs.typesafe.ai/api.md is now asserted
 * directly, so a drift shows up here rather than as a silent fallback in
 * production.
 */

const ORIGINAL = { ...process.env };

function fakeModel(id: string): LanguageModel {
  return {
    provider: 'local',
    isRemote: false,
    id,
    complete: async () => ({
      text: '',
      toolCalls: [],
      stopReason: 'stop' as const,
      usage: { promptTokens: 0, completionTokens: 0 },
      model: id,
    }),
    completeStructured: async () => ({
      value: {} as never,
      usage: { promptTokens: 0, completionTokens: 0 },
      model: id,
      confidence: 1,
    }),
  };
}

/**
 * Four candidates, one per strength, across providers. Keyed by the strength
 * name so each test reads the same as when Jev picked a tier.
 */
const PROVIDER_BY_STRENGTH: Record<Tier, RoutableModel['provider']> = {
  tiny: 'anthropic',
  everyday: 'openai',
  large: 'google',
  hardest: 'anthropic',
};

function candidate(strength: Tier): RoutableModel {
  return {
    key: strength,
    provider: PROVIDER_BY_STRENGTH[strength],
    modelId: `model-${strength}`,
    strength,
    criteria: `Criteria for the ${strength} model.`,
    model: fakeModel(`tier-${strength}`),
  };
}

const CANDIDATES: RoutableModel[] = TIERS.map(candidate);

/** A subset of the candidates, in the order given. */
function only(...strengths: Tier[]): RoutableModel[] {
  return strengths.map(candidate);
}
const DEFAULT_MODEL = fakeModel('default');

/** A response in the documented shape: answers keyed by question id. */
function jevResponds(
  tier: string,
  confidence: number,
  opts: { stakes?: number; stakesConfidence?: number } = {},
) {
  const answers: Record<string, unknown> = {
    model: { type: 'choice', choice: tier, confidence, probabilities: { [tier]: confidence } },
  };
  if (opts.stakes !== undefined) {
    answers['stakes'] = {
      type: 'score',
      score: opts.stakes,
      confidence: opts.stakesConfidence ?? 0.9,
      legend: {},
      probabilities: {},
    };
  }
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          model: JEV_MODEL_ID,
          answers,
          usage: { input_tokens: 296, output_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
}

/** Build a JevResult without a round trip, for the accessor tests. */
function resultOf(answers: JevResult['answers']): JevResult {
  return { answers, latencyMs: 1, inputTokens: 1, outputTokens: 0, costUsd: 0 };
}

beforeEach(() => {
  __resetJevWarnings();
  vi.restoreAllMocks();
  process.env['JEV_ROUTER'] = 'on';
  process.env['TYPESAFE_API_KEY'] = 'ts-test-key';
  process.env['JEV_SEND_CONTENT'] = 'false';
  // env is validated and cached per-process, so the module must be re-read.
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function freshRouter() {
  vi.resetModules();
  return import('@/lib/ai/router');
}

function sentBody(spy: ReturnType<typeof vi.fn>): Record<string, any> {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('the documented wire format', () => {
  it('posts to the System One endpoint with a bearer key', async () => {
    const spy = jevResponds('everyday', 0.9);
    vi.stubGlobal('fetch', spy);
    const { routeTask: route } = await freshRouter();
    await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ts-test-key');
  });

  it('names a pinned model rather than a moving alias', () => {
    // jev-latest would change behaviour without a commit.
    expect(JEV_MODEL_ID).toBe('jev-1.13.0');
    expect(JEV_MODEL_ID).not.toContain('latest');
  });

  it('sends questions as a keyed map with instructions and criteria', async () => {
    const spy = jevResponds('everyday', 0.9);
    vi.stubGlobal('fetch', spy);
    const { routeTask: route } = await freshRouter();
    await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    const body = sentBody(spy);
    expect(body['model']).toBe(JEV_MODEL_ID);
    // A map, not an array: the ids are the keys.
    expect(Array.isArray(body['questions'])).toBe(false);
    expect(Object.keys(body['questions']).sort()).toEqual(['model', 'stakes']);

    const model = body['questions']['model'];
    expect(model['type']).toBe('choice');
    expect(typeof model['instructions']).toBe('string');
    // Option meanings belong in criteria, not smashed into the instructions.
    expect(Object.keys(model['criteria'])).toEqual(['tiny', 'everyday', 'large', 'hardest']);
    expect(model['criteria']['tiny']).toBe('Criteria for the tiny model.');
    expect(model['instructions']).not.toContain('Criteria for the');

    const stakes = body['questions']['stakes'];
    expect(stakes['type']).toBe('score');
    // Score criteria is an ordered array of level descriptions.
    expect(Array.isArray(stakes['criteria'])).toBe(true);
    expect(stakes['criteria'].length).toBeGreaterThanOrEqual(2);
    expect(stakes['criteria'].length).toBeLessThanOrEqual(10);
  });

  it('asks both independent questions in one call', async () => {
    const spy = jevResponds('everyday', 0.9, { stakes: 1 });
    vi.stubGlobal('fetch', spy);
    const { routeTask: route } = await freshRouter();
    await route({ task: 'draft_email' }, CANDIDATES, DEFAULT_MODEL);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed question locally instead of spending a 422', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    vi.resetModules();
    const { askJev: ask } = await import('@/lib/ai/jev');

    // A one-option choice and a one-level score are both invalid per the docs.
    await expect(ask('state', { q: choice('pick', { only: null }) })).resolves.toBeNull();
    await expect(ask('state', { q: score('rate', ['just one']) })).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('never blocks', () => {
  it('falls back when Jev times out', async () => {
    // Jev never answers. The router must return anyway.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );

    const { routeTask: route } = await freshRouter();
    const started = Date.now();
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.reason).toBe('jev_unavailable');
    expect(decision.model.id).toBe('default');
    expect(decision.fellBack).toBe(true);
    // The abort budget is 1.2s; anything near a normal request timeout is a bug.
    expect(Date.now() - started).toBeLessThan(4000);
  }, 20_000);

  it('falls back on every documented error status, without retrying', async () => {
    for (const status of [401, 422, 429, 529, 502]) {
      const spy = vi.fn(async () => new Response('nope', { status }));
      vi.stubGlobal('fetch', spy);
      const { routeTask: route } = await freshRouter();
      const decision = await route({ task: 'draft_email' }, CANDIDATES, DEFAULT_MODEL);

      expect(decision.reason, `status ${status}`).toBe('jev_unavailable');
      expect(decision.model.id).toBe('default');
      // A retry inside a 1.2s routing budget would just be a slower fallback.
      expect(spy, `status ${status}`).toHaveBeenCalledTimes(1);
    }
  });

  it('falls back when Jev returns a shape we do not recognise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ surprise: true }), { status: 200 })),
    );
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'summarize_account' }, CANDIDATES, DEFAULT_MODEL);
    expect(decision.reason).toBe('jev_unavailable');
  });

  it('never throws, whatever the transport does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('DNS exploded'); }));
    const { routeTask: route } = await freshRouter();
    await expect(
      route({ task: 'answer_question' }, CANDIDATES, DEFAULT_MODEL),
    ).resolves.toMatchObject({ fellBack: true });
  });
});

describe('never guesses', () => {
  it('uses the tier Jev picked when it is confident', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.97));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.reason).toBe('jev');
    expect(decision.chosen?.key).toBe('tiny');
    expect(decision.model.id).toBe('tier-tiny');
    expect(decision.fellBack).toBe(false);
    expect(decision.confidence).toBeCloseTo(0.97);
  });

  it('falls back below the confidence floor', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.42));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.reason).toBe('low_confidence');
    expect(decision.confidence).toBeCloseTo(0.42);
    expect(decision.model.id).toBe('default');
    expect(decision.fellBack).toBe(true);
  });

  it('treats a missing confidence as unusable rather than certain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ answers: { model: { type: 'choice', choice: 'hardest' } } }),
            { status: 200 },
          ),
      ),
    );
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'generate_insights' }, CANDIDATES, DEFAULT_MODEL);
    expect(decision.model.id).toBe('default');
  });

  it('rejects a tier Jev invented', async () => {
    vi.stubGlobal('fetch', jevResponds('gigantic', 0.99));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'answer_question' }, CANDIDATES, DEFAULT_MODEL);
    expect(decision.model.id).toBe('default');
  });

  it('drops an answer whose type is not the one asked for', async () => {
    // Reading `.score` off a choice answer, or vice versa, would be a
    // fabricated decision. A type mismatch is treated as no answer.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: { model: { type: 'score', score: 2, confidence: 0.99 } },
            }),
            { status: 200 },
          ),
      ),
    );
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);
    expect(decision.reason).toBe('jev_unavailable');
  });

  it('honours the floor constant rather than a magic number', () => {
    // TypeSafe's documented baseline for "genuinely uncertain" is 0.5; routing
    // sits above it deliberately.
    expect(JEV_CONFIDENCE_FLOOR).toBe(0.6);
    expect(JEV_CONFIDENCE_FLOOR).toBeGreaterThan(0.5);

    const below = resultOf({
      t: { type: 'choice', choice: 'tiny', confidence: 0.59, probabilities: {} },
    });
    const above = resultOf({
      t: { type: 'choice', choice: 'tiny', confidence: 0.61, probabilities: {} },
    });
    expect(confidentChoice(below, 't', ['tiny'])).toBeNull();
    expect(confidentChoice(above, 't', ['tiny'])).not.toBeNull();
  });
});

describe('answer semantics', () => {
  it('reads a choice as the option key, never its description', async () => {
    vi.resetModules();
    const { askJev: ask } = await import('@/lib/ai/jev');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: {
                team: {
                  type: 'choice',
                  choice: 'sales',
                  confidence: 0.81,
                  probabilities: { sales: 0.81, support: 0.19 },
                },
              },
              usage: { input_tokens: 10, output_tokens: 2 },
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await ask(
      { email: 'hello' },
      { team: choice('Which team?', { sales: 'Wants to buy.', support: 'Has a problem.' }) },
    );
    const answer = result?.answers['team'];
    expect(answer?.type).toBe('choice');
    expect(answer).toMatchObject({ choice: 'sales', confidence: 0.81 });
    expect(result?.answers['team']).toHaveProperty('probabilities.support', 0.19);
  });

  it('reads a score as a 0-based position across the levels it offered', async () => {
    vi.resetModules();
    const { askJev: ask } = await import('@/lib/ai/jev');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: { sev: { type: 'score', score: 1.43, confidence: 0.35 } },
              usage: { input_tokens: 10, output_tokens: 2 },
            }),
            { status: 200 },
          ),
      ),
    );

    const q = { sev: score('How severe?', ['Cosmetic.', 'Degraded.', 'Blocking.']) };
    const result = await ask('the bug', q);
    const answer = result?.answers['sev'];
    expect(answer).toMatchObject({ type: 'score', score: 1.43, levels: 3 });

    // 0.35 is below the floor, so a caller asking for a single bucket gets none.
    expect(confidentScore(result, 'sev')).toBeNull();
    expect(confidentScore(result, 'sev', 0.3)).toMatchObject({ level: 1, exact: 1.43 });
  });

  it('accepts a noul as a bare probability with no confidence field', async () => {
    // Nouls genuinely do not carry confidence. Demanding one would discard
    // every noul answer the API ever returns.
    vi.resetModules();
    const { askJev: ask } = await import('@/lib/ai/jev');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: { urgent: { type: 'noul', noul: 0.95 } },
              usage: { input_tokens: 10, output_tokens: 2 },
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await ask('payouts failing', { urgent: noul('Is this urgent?') });
    expect(result?.answers['urgent']).toEqual({ type: 'noul', noul: 0.95 });
    expect(likely(result, 'urgent')).toBe(true);
    expect(likely(result, 'urgent', 0.99)).toBe(false);
    expect(likely(result, 'missing')).toBeNull();
  });
});

describe('policy is code, not prompt', () => {
  it('moves a job up a tier when a wrong answer would reach a customer', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.95, { stakes: 2 }));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'draft_email' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.reason).toBe('jev');
    expect(decision.stakes).toBe(2);
    expect(decision.raisedForStakes).toBe(true);
    expect(decision.chosen?.key).toBe('everyday');
    expect(decision.model.id).toBe('tier-everyday');
  });

  it('leaves low-stakes jobs on the tier Jev picked', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.95, { stakes: 0 }));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.stakes).toBe(0);
    expect(decision.raisedForStakes).toBe(false);
    expect(decision.chosen?.key).toBe('tiny');
  });

  it('does not escalate on an unsure stakes reading', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.95, { stakes: 2, stakesConfidence: 0.2 }));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'draft_email' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.stakes).toBeNull();
    expect(decision.raisedForStakes).toBe(false);
    expect(decision.chosen?.key).toBe('tiny');
  });

  it('cannot escalate past the largest configured tier', async () => {
    vi.stubGlobal('fetch', jevResponds('large', 0.95, { stakes: 2 }));
    const { routeTask: route } = await freshRouter();
    const decision = await route(
      { task: 'generate_insights' },
      only('tiny', 'large'),
      DEFAULT_MODEL,
    );
    expect(decision.chosen?.key).toBe('large');
    expect(decision.raisedForStakes).toBe(false);
  });
});

describe('never leaks', () => {
  const evidence: EvidenceItem[] = [
    {
      ref: { type: 'email', id: 'eml_1', label: 'Re: renewal' },
      content: 'We are going to have to seriously reconsider at renewal. Our CFO is furious.',
      trust: 'untrusted',
    },
  ];

  it('describes the job without quoting customer content', () => {
    const state = describeJob({ task: 'extract_objections', evidence });
    const json = JSON.stringify(state);
    expect(json).not.toContain('reconsider at renewal');
    expect(json).not.toContain('CFO');
    // But it must still carry enough structure to size the job.
    expect(state).toMatchObject({
      job: 'extract objections',
      evidence_items: 1,
      untrusted_sources: 1,
    });
  });

  it('withholds even the operator instruction until opted in', () => {
    const state = describeJob({
      task: 'answer_question',
      instruction: 'why is Solstice Energy about to churn',
      evidence,
    });
    expect(JSON.stringify(state)).not.toContain('Solstice');
    expect(state).toHaveProperty('request_characters');
  });

  it('sends only the operator instruction when opted in, never the evidence', async () => {
    process.env['JEV_SEND_CONTENT'] = 'true';
    vi.resetModules();
    const { describeJob: describe2 } = await import('@/lib/ai/router');

    const state = describe2({
      task: 'answer_question',
      instruction: 'why is Solstice Energy about to churn',
      evidence,
    });
    const json = JSON.stringify(state);
    expect(json).toContain('Solstice Energy');
    // The customer's words stay put even with content sending on.
    expect(json).not.toContain('reconsider at renewal');
  });

  it('keeps customer content out of the request that actually goes over the wire', async () => {
    const spy = jevResponds('everyday', 0.9);
    vi.stubGlobal('fetch', spy);
    const { routeTask: route } = await freshRouter();
    await route({ task: 'extract_objections', evidence }, CANDIDATES, DEFAULT_MODEL);

    // The end-to-end check, not just the state builder in isolation.
    const raw = (spy.mock.calls[0]?.[1] as RequestInit).body as string;
    expect(raw).not.toContain('CFO');
    expect(raw).not.toContain('reconsider');
  });
});

describe('stays out of the way', () => {
  it('does nothing when the router is off', async () => {
    process.env['JEV_ROUTER'] = 'off';
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { routeTask: route } = await import('@/lib/ai/router');
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);

    expect(decision.reason).toBe('router_off');
    expect(decision.model.id).toBe('default');
    // Off means off: not one request leaves.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing without a key', async () => {
    delete process.env['TYPESAFE_API_KEY'];
    vi.resetModules();
    const { routeTask: route } = await import('@/lib/ai/router');
    const decision = await route({ task: 'classify_intent' }, CANDIDATES, DEFAULT_MODEL);
    expect(decision.reason).toBe('jev_not_configured');
  });

  it('does nothing when there is only one model to choose from', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { routeTask: route } = await freshRouter();
    const decision = await route(
      { task: 'classify_intent' },
      only('everyday'),
      DEFAULT_MODEL,
    );

    expect(decision.reason).toBe('single_model');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('offers Jev only the tiers that actually have a model', async () => {
    // Offering a tier with no model behind it would make Jev's answer unusable.
    const spy = jevResponds('large', 0.95);
    vi.stubGlobal('fetch', spy);
    const { routeTask: route } = await freshRouter();

    const decision = await route(
      { task: 'generate_insights' },
      only('tiny', 'large'),
      DEFAULT_MODEL,
    );

    const body = sentBody(spy);
    expect(Object.keys(body['questions']['model']['criteria'])).toEqual(['tiny', 'large']);
    expect(decision.chosen?.key).toBe('large');
    expect(decision.model.id).toBe('tier-large');
  });

  it('ignores an answer naming a tier it was never offered', async () => {
    vi.stubGlobal('fetch', jevResponds('hardest', 0.99));
    const { routeTask: route } = await freshRouter();
    const decision = await route(
      { task: 'generate_insights' },
      only('tiny', 'large'),
      DEFAULT_MODEL,
    );
    // Confident, but out of range: the default runs rather than a guess.
    expect(decision.model.id).toBe('default');
    expect(decision.fellBack).toBe(true);
  });
});

describe('cost accounting', () => {
  it('bills from the usage the API reports, not an estimate', async () => {
    vi.stubGlobal('fetch', jevResponds('everyday', 0.9));
    const { routeTask: route } = await freshRouter();
    const decision = await route(
      { task: 'summarize_meeting', evidence: [] },
      CANDIDATES,
      DEFAULT_MODEL,
    );

    expect(decision.jevLatencyMs).toBeGreaterThanOrEqual(0);
    // 296 input tokens at $0.042/1M, exactly as the response reported.
    expect(decision.jevCostUsd!).toBeCloseTo((296 * 0.042) / 1_000_000, 12);
    // A routing decision must stay a rounding error.
    expect(decision.jevCostUsd!).toBeLessThan(0.0001);
  });
});

describe('the Jev client itself', () => {
  it('returns null rather than throwing when unconfigured', async () => {
    delete process.env['TYPESAFE_API_KEY'];
    vi.resetModules();
    const { askJev: ask, noul: n } = await import('@/lib/ai/jev');
    await expect(ask('some state', { q: n('true?') })).resolves.toBeNull();
  });

  it('never asks Jev to write anything', async () => {
    // Jev's weak spots are writing, chat, reasoning, counting, maths and dates.
    // The client exposes only the three decision shapes, by construction.
    const mod = await import('@/lib/ai/jev');
    const surface = Object.keys(mod).join(' ');
    expect(surface).not.toMatch(/complete|generate|write|draft/i);
  });
});

describe('tier vocabulary', () => {
  it('is ordered smallest to largest', () => {
    expect(TIERS).toEqual(['tiny', 'everyday', 'large', 'hardest']);
  });
});
