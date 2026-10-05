import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Jev deciding whether an LLM is needed at all.
 *
 * Ask Bolt classifies every question before doing anything else. That is a
 * decision, not writing, so Jev answers it alone — and the LLM only runs when
 * Jev is unsure, or not allowed to read the question.
 *
 * The privacy rule is pinned first: the question is the user's own words, so
 * nothing is sent unless JEV_SEND_CONTENT says so, and customer content has
 * its own, separate switch.
 */

const ORIGINAL = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
}

const ON = { JEV_ROUTER: 'on', TYPESAFE_API_KEY: 'ts-test', JEV_SEND_CONTENT: 'true' };

/** A Jev response in the documented shape. */
function jevSays(answers: Record<string, unknown>) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 400, output_tokens: 0 } }),
  );
}

const choiceOf = (value: string, confidence: number) => ({
  type: 'choice',
  choice: value,
  confidence,
  probabilities: {},
});
const noulOf = (p: number) => ({ type: 'noul', noul: p });

async function classify(question: string) {
  const { classifyIntentWithJev } = await import('@/server/ai/jev-intent');
  return classifyIntentWithJev(question);
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL };
});

describe('what Jev may read', () => {
  it('sends nothing without JEV_SEND_CONTENT, so the LLM path runs', async () => {
    setEnv({ ...ON, JEV_SEND_CONTENT: 'false' });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await classify('Which deals are at risk?')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends nothing with routing off or no key', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    setEnv({ ...ON, JEV_ROUTER: 'off' });
    expect(await classify('Which deals are at risk?')).toBeNull();
    setEnv({ ...ON, TYPESAFE_API_KEY: undefined });
    expect(await classify('Which deals are at risk?')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps customer content on its own switch, off by default', async () => {
    setEnv(ON);
    const { jevMayRead } = await import('@/lib/ai/jev-first');
    expect(jevMayRead('job_shape')).toBe(true);
    expect(jevMayRead('operator_text')).toBe(true);
    // Allowing the user's own words never implies allowing customers' words.
    expect(jevMayRead('customer_content')).toBe(false);
  });
});

describe('Jev decides, no LLM', () => {
  it('classifies intent, timeframe and record types in one call', async () => {
    setEnv(ON);
    const spy = jevSays({
      intent: choiceOf('analytics', 0.94),
      timeframe: choiceOf('last_quarter', 0.88),
      scope_deals: noulOf(0.97),
      scope_emails: noulOf(0.1),
      scope_meetings: noulOf(0.05),
    });
    vi.stubGlobal('fetch', spy);

    const intent = await classify('Which deals are at risk this quarter?');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(intent?.intent).toBe('analytics');
    expect(intent?.timeframeDays).toBe(90);
    // The core record types, plus what Jev added: deal history.
    expect(intent?.scopes).toEqual(
      expect.arrayContaining(['emails', 'meetings', 'opportunities', 'crm_events']),
    );
    expect(intent?.scopes).not.toContain('objections');
    expect(intent?.confidence).toBeCloseTo(0.94);

    // One call, every question in it; the question itself is the state.
    const body = JSON.parse(String(spy.mock.calls[0]![1]!.body));
    expect(Object.keys(body.questions)).toEqual(
      expect.arrayContaining(['intent', 'timeframe', 'scope_emails', 'scope_deals']),
    );
    expect(JSON.stringify(body)).toContain('Which deals are at risk this quarter?');
  });

  it('errs towards searching more record types, not fewer', async () => {
    setEnv(ON);
    vi.stubGlobal(
      'fetch',
      jevSays({
        intent: choiceOf('search', 0.9),
        scope_concerns: noulOf(0.4),
        scope_notes: noulOf(0.2),
      }),
    );
    const intent = await classify('What did Acme say about pricing?');
    // 0.4 is under even odds, but a missed scope is a missed answer.
    expect(intent?.scopes).toContain('objections');
    expect(intent?.scopes).not.toContain('notes');
  });

  it('always searches the core record types, even if Jev says no to emails', async () => {
    // From a live run: Jev said no to emails for a question whose answer was
    // in an email. Core types are never Jev's to remove.
    setEnv(ON);
    vi.stubGlobal('fetch', jevSays({ intent: choiceOf('search', 0.9), scope_emails: noulOf(0.02) }));
    const intent = await classify('What did Acme say about pricing?');
    expect(intent?.scopes).toEqual(
      expect.arrayContaining(['accounts', 'opportunities', 'emails', 'meetings', 'transcripts']),
    );
  });

  it('reads an unsure timeframe as all time', async () => {
    setEnv(ON);
    vi.stubGlobal('fetch', jevSays({ intent: choiceOf('search', 0.9), timeframe: choiceOf('last_week', 0.3) }));
    expect((await classify('Find the Acme contract'))?.timeframeDays).toBe(0);
  });
});

describe('when Jev is unsure, the LLM makes the call', () => {
  it('hands over below the confidence floor', async () => {
    setEnv(ON);
    vi.stubGlobal('fetch', jevSays({ intent: choiceOf('draft', 0.41) }));
    expect(await classify('hmm, thoughts on the Pinecrest thing?')).toBeNull();
  });

  it('hands over on an intent it was never offered', async () => {
    setEnv(ON);
    vi.stubGlobal('fetch', jevSays({ intent: choiceOf('delete_everything', 0.99) }));
    expect(await classify('Which deals are at risk?')).toBeNull();
  });

  it('hands over when Jev is down, without throwing', async () => {
    setEnv(ON);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })));
    expect(await classify('Which deals are at risk?')).toBeNull();
  });
});
