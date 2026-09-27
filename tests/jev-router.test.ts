import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetJevWarnings, askJev, confidentChoice, JEV_CONFIDENCE_FLOOR } from '@/lib/ai/jev';
import { describeJob, routeTask, TIERS, type Tier } from '@/lib/ai/router';
import type { EvidenceItem, LanguageModel } from '@/lib/ai/types';

/**
 * Jev as the decision maker for model selection.
 *
 * Three properties matter more than the routing itself, and each of them is a
 * way the feature could quietly make the product worse:
 *
 *   never block  — a router that can stall the CRM is worse than none
 *   never guess  — below 0.6 confidence the default runs, per TypeSafe
 *   never leak   — customer email and transcripts must not reach a third
 *                  party to settle a routing question
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

const TIER_MODELS: Partial<Record<Tier, LanguageModel>> = {
  tiny: fakeModel('tier-tiny'),
  everyday: fakeModel('tier-everyday'),
  large: fakeModel('tier-large'),
  hardest: fakeModel('tier-hardest'),
};
const DEFAULT_MODEL = fakeModel('default');

/** One Jev-shaped response. */
function jevResponds(value: string, confidence: number) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ answers: [{ id: 'tier', value, confidence }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  __resetJevWarnings();
  vi.restoreAllMocks();
  process.env['JEV_ROUTER'] = 'on';
  process.env['OPENROUTER_API_KEY'] = 'sk-or-test-key';
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
    const decision = await route({ task: 'classify_intent' }, TIER_MODELS, DEFAULT_MODEL);

    expect(decision.reason).toBe('jev_unavailable');
    expect(decision.model.id).toBe('default');
    expect(decision.fellBack).toBe(true);
    // The abort budget is 1.2s; anything near a normal request timeout is a bug.
    expect(Date.now() - started).toBeLessThan(4000);
  }, 20_000);

  it('falls back when Jev returns an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'draft_email' }, TIER_MODELS, DEFAULT_MODEL);
    expect(decision.reason).toBe('jev_unavailable');
    expect(decision.model.id).toBe('default');
  });

  it('falls back when Jev returns a shape we do not recognise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ surprise: true }), { status: 200 })),
    );
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'summarize_account' }, TIER_MODELS, DEFAULT_MODEL);
    expect(decision.reason).toBe('jev_unavailable');
  });

  it('never throws, whatever the transport does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('DNS exploded'); }));
    const { routeTask: route } = await freshRouter();
    await expect(route({ task: 'answer_question' }, TIER_MODELS, DEFAULT_MODEL)).resolves.toMatchObject(
      { fellBack: true },
    );
  });
});

describe('never guesses', () => {
  it('uses the tier Jev picked when it is confident', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.97));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, TIER_MODELS, DEFAULT_MODEL);

    expect(decision.reason).toBe('jev');
    expect(decision.tier).toBe('tiny');
    expect(decision.model.id).toBe('tier-tiny');
    expect(decision.fellBack).toBe(false);
    expect(decision.confidence).toBeCloseTo(0.97);
  });

  it('falls back below the 0.6 confidence floor', async () => {
    vi.stubGlobal('fetch', jevResponds('tiny', 0.42));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, TIER_MODELS, DEFAULT_MODEL);

    expect(decision.reason).toBe('low_confidence');
    expect(decision.model.id).toBe('default');
    expect(decision.fellBack).toBe(true);
  });

  it('treats a missing confidence as unusable rather than certain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answers: [{ id: 'tier', value: 'hardest' }] }), { status: 200 })),
    );
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'generate_insights' }, TIER_MODELS, DEFAULT_MODEL);
    expect(decision.model.id).toBe('default');
  });

  it('rejects a tier Jev invented', async () => {
    vi.stubGlobal('fetch', jevResponds('gigantic', 0.99));
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'answer_question' }, TIER_MODELS, DEFAULT_MODEL);
    expect(decision.model.id).toBe('default');
  });

  it('honours the floor constant rather than a magic number', () => {
    expect(JEV_CONFIDENCE_FLOOR).toBe(0.6);
    expect(confidentChoice(
      { answers: { t: { id: 't', value: 'tiny', confidence: 0.59 } }, latencyMs: 1, inputTokens: 1, costUsd: 0 },
      't',
      ['tiny'],
    )).toBeNull();
    expect(confidentChoice(
      { answers: { t: { id: 't', value: 'tiny', confidence: 0.61 } }, latencyMs: 1, inputTokens: 1, costUsd: 0 },
      't',
      ['tiny'],
    )).not.toBeNull();
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
    expect(state).not.toContain('reconsider at renewal');
    expect(state).not.toContain('CFO');
    // But it must still carry enough structure to size the job.
    expect(state).toContain('extract objections');
    expect(state).toContain('Evidence items: 1');
    expect(state).toContain('Untrusted sources among them: 1');
  });

  it('withholds even the operator instruction until opted in', () => {
    const state = describeJob({
      task: 'answer_question',
      instruction: 'why is Solstice Energy about to churn',
      evidence,
    });
    expect(state).not.toContain('Solstice');
    expect(state).toContain('Request length:');
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
    expect(state).toContain('Solstice Energy');
    // The customer's words stay put even with content sending on.
    expect(state).not.toContain('reconsider at renewal');
  });
});

describe('stays out of the way', () => {
  it('does nothing when the router is off', async () => {
    process.env['JEV_ROUTER'] = 'off';
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { routeTask: route } = await import('@/lib/ai/router');
    const decision = await route({ task: 'classify_intent' }, TIER_MODELS, DEFAULT_MODEL);

    expect(decision.reason).toBe('router_off');
    expect(decision.model.id).toBe('default');
    // Off means off: not one request leaves.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing without a key', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    vi.resetModules();
    const { routeTask: route } = await import('@/lib/ai/router');
    const decision = await route({ task: 'classify_intent' }, TIER_MODELS, DEFAULT_MODEL);
    expect(decision.reason).toBe('jev_not_configured');
  });

  it('does nothing when there is only one model to choose from', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { routeTask: route } = await freshRouter();
    const decision = await route({ task: 'classify_intent' }, { everyday: TIER_MODELS.everyday }, DEFAULT_MODEL);

    expect(decision.reason).toBe('single_model');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('offers Jev only the tiers that actually have a model', async () => {
    // "If I have fewer models than sizes, use fewer sizes." Offering a tier
    // with no model behind it would make Jev's answer unusable.
    const spy = jevResponds('large', 0.95);
    vi.stubGlobal('fetch', spy);
    const { routeTask: route } = await freshRouter();

    const decision = await route(
      { task: 'generate_insights' },
      { tiny: TIER_MODELS.tiny, large: TIER_MODELS.large },
      DEFAULT_MODEL,
    );

    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      questions: { options: string[] }[];
    };
    expect(body.questions[0]!.options).toEqual(['tiny', 'large']);
    expect(decision.tier).toBe('large');
    expect(decision.model.id).toBe('tier-large');
  });

  it('ignores an answer naming a tier it was never offered', async () => {
    vi.stubGlobal('fetch', jevResponds('hardest', 0.99));
    const { routeTask: route } = await freshRouter();
    const decision = await route(
      { task: 'generate_insights' },
      { tiny: TIER_MODELS.tiny, large: TIER_MODELS.large },
      DEFAULT_MODEL,
    );
    // Confident, but out of range: the default runs rather than a guess.
    expect(decision.model.id).toBe('default');
    expect(decision.fellBack).toBe(true);
  });
});

describe('cost accounting', () => {
  it('reports latency and a cost derived from the published input price', async () => {
    vi.stubGlobal('fetch', jevResponds('everyday', 0.9));
    const { routeTask: route } = await freshRouter();
    const decision = await route(
      { task: 'summarize_meeting', evidence: [] },
      TIER_MODELS,
      DEFAULT_MODEL,
    );

    expect(decision.jevLatencyMs).toBeGreaterThanOrEqual(0);
    expect(decision.jevCostUsd).toBeGreaterThan(0);
    // $0.042 per 1M input tokens makes a routing decision a rounding error.
    expect(decision.jevCostUsd!).toBeLessThan(0.0001);
  });
});

describe('the Jev client itself', () => {
  it('returns null rather than throwing when unconfigured', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    vi.resetModules();
    const { askJev: ask } = await import('@/lib/ai/jev');
    await expect(ask('some state', [{ id: 'q', kind: 'noul', question: 'true?' }])).resolves.toBeNull();
  });

  it('accepts the documented answer shapes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            answers: [
              { id: 'c', value: 'sales', confidence: 1 },
              { id: 's', value: 2.99, confidence: 0.99 },
              { id: 'n', value: 0.78, confidence: 0.8 },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.resetModules();
    const { askJev: ask } = await import('@/lib/ai/jev');

    const result = await ask('one email', [
      { id: 'c', kind: 'choice', question: 'which team?', options: ['sales', 'support'] },
      { id: 's', kind: 'score', question: 'how good a lead?', min: 0, max: 3 },
      { id: 'n', kind: 'noul', question: 'needs a reply today?' },
    ]);

    expect(result?.answers['c']?.value).toBe('sales');
    expect(result?.answers['s']?.value).toBe(2.99);
    expect(result?.answers['n']?.value).toBe(0.78);
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
