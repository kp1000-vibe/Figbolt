import { env } from '@/lib/env';

/**
 * Jev — a System One decision model from TypeSafe AI.
 *
 * Jev is not an LLM and never writes text. You hand it a state plus typed
 * questions and it hands back calibrated decisions, in one parallel pass.
 * Input costs $0.042 per million tokens and output is free, which is what
 * makes it viable in places a chat model was always too slow and too expensive
 * to sit — like deciding, per request, which model should do the actual work.
 *
 * Three question types, and only three:
 *
 *   choice  pick one of the option keys you define
 *   score   a probability-weighted position across ordered levels you define
 *   noul    the probability a statement is true
 *
 * Two rules, both enforced here rather than left to the caller's discretion:
 *
 *   1. **Jev decides, the writer writes.** Nothing in this module produces
 *      prose, and the router it feeds never lets Jev author anything.
 *   2. **An unsure answer is not an answer.** Jev is weak at maths, dates,
 *      counting, and long input padded with irrelevant text. Below the
 *      confidence floor the caller decides instead.
 *
 * Every call is wrapped so that a slow, missing or broken Jev is
 * indistinguishable from Jev being switched off. A router that can stall the
 * CRM is worse than no router.
 *
 * Wire format per https://docs.typesafe.ai/api.md — request and response are
 * both keyed maps, questions carry `instructions` and `criteria`, and noul
 * answers carry a probability with no confidence field. There is an official
 * SDK (`@typesafe-ai/sdk`); this stays a direct fetch because the failure
 * semantics below — one attempt, hard deadline, never throw, never retry — are
 * the whole point of the module and are easier to guarantee than to configure.
 */

/** Pinned rather than `jev-latest`, so a model bump is a visible commit. */
export const JEV_MODEL_ID = 'jev-1.13.0';
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * TypeSafe's documented baseline for "genuinely uncertain" is 0.5, and their
 * guidance is that the real threshold depends on your domain and consequences.
 * Routing sits above the baseline: picking a too-small model produces a bad
 * answer the user has to notice, so we want a clear winner or nothing.
 */
export const JEV_CONFIDENCE_FLOOR = 0.6;

/** Jev answers in a fraction of a second. Past this it is a fault, not slowness. */
const TIMEOUT_MS = 1200;

/** $0.042 per 1M input tokens; output is free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * Jev takes 64k tokens per request, with a 32k budget for the state plus the
 * longest single question. This cap is far below that: the router sends a
 * short structural description, and anything approaching the real limit would
 * mean a caller is shipping content it should not be.
 */
const MAX_STATE_CHARS = 24_000;

/** Docs allow a string, a JSON object, or an array of text. */
export type JevState = string | Record<string, unknown> | readonly unknown[];

export type JevQuestion =
  | {
      kind: 'choice';
      instructions: string;
      /** Option key -> what it means. Null where the key speaks for itself. */
      options: Record<string, string | null>;
    }
  | {
      kind: 'score';
      instructions: string;
      /** 2–10 ordered levels, each describing a concrete situation. */
      levels: readonly string[];
    }
  | { kind: 'noul'; instructions: string; whenTrue?: string; whenFalse?: string };

export type JevQuestions = Record<string, JevQuestion>;

export type JevChoiceAnswer = {
  type: 'choice';
  /** The option key Jev picked, never its description. */
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type JevScoreAnswer = {
  type: 'score';
  /** Probability-weighted mean level, 0-based across the levels you defined. */
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  /** How many levels were offered, so callers can normalise. */
  levels: number;
};

/** Nouls report a probability and carry no confidence field of their own. */
export type JevNoulAnswer = { type: 'noul'; noul: number };

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export type JevResult = {
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export function jevConfigured(): boolean {
  return Boolean(env.TYPESAFE_API_KEY);
}

/** Question builders, so a malformed question is a type error where possible. */
export function choice(
  instructions: string,
  options: Record<string, string | null>,
): JevQuestion {
  return { kind: 'choice', instructions, options };
}

export function score(instructions: string, levels: readonly string[]): JevQuestion {
  return { kind: 'score', instructions, levels };
}

export function noul(
  instructions: string,
  criteria?: { whenTrue?: string; whenFalse?: string },
): JevQuestion {
  return { kind: 'noul', instructions, ...criteria };
}

/**
 * Ask Jev a set of typed questions about one state.
 *
 * Independent questions belong in one call: they run in parallel, cannot see
 * each other's answers, and cost only their own tokens.
 *
 * Returns null — never throws — when Jev is not configured, when a question is
 * malformed, or when the service times out, errors, or answers in a shape we
 * do not recognise. Every caller treats null as "decide it yourself".
 */
export async function askJev(
  state: JevState,
  questions: JevQuestions,
): Promise<JevResult | null> {
  const key = env.TYPESAFE_API_KEY;
  if (!key) return null;

  const ids = Object.keys(questions);
  if (ids.length === 0) return null;

  const wire: Record<string, unknown> = {};
  for (const id of ids) {
    const built = toWireQuestion(questions[id]!);
    if (!built) {
      // A question Jev would reject with a 422. Refusing locally keeps the
      // failure in the developer's face instead of in production logs.
      warnOnce(`[jev] question "${id}" is malformed and was not sent`);
      return null;
    }
    wire[id] = built;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL_ID,
        state: trimState(state),
        questions: wire,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      warnOnce(`[jev] ${res.status} ${explainStatus(res.status)}; the caller decides instead`);
      return null;
    }

    const body = (await res.json()) as unknown;
    const parsed = parseResult(body, questions);
    if (!parsed) {
      warnOnce('[jev] unrecognised response shape; the caller decides instead');
      return null;
    }

    return {
      ...parsed,
      latencyMs: Date.now() - started,
      costUsd: parsed.inputTokens * USD_PER_INPUT_TOKEN,
    };
  } catch (err) {
    // An abort is the expected failure, not an exceptional one.
    const aborted = (err as Error).name === 'AbortError';
    warnOnce(
      aborted
        ? `[jev] no answer within ${TIMEOUT_MS}ms; the caller decides instead`
        : `[jev] unreachable (${(err as Error).message}); the caller decides instead`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Null for a question the API would reject, so we never spend a request on it. */
function toWireQuestion(q: JevQuestion): Record<string, unknown> | null {
  if (!q.instructions.trim()) return null;

  switch (q.kind) {
    case 'choice': {
      const keys = Object.keys(q.options);
      // Two is the minimum for a decision; 255 is the documented ceiling.
      if (keys.length < 2 || keys.length > 255) return null;
      return { type: 'choice', instructions: q.instructions, criteria: q.options };
    }
    case 'score': {
      if (q.levels.length < 2 || q.levels.length > 10) return null;
      return { type: 'score', instructions: q.instructions, criteria: [...q.levels] };
    }
    case 'noul': {
      const wire: Record<string, unknown> = { type: 'noul', instructions: q.instructions };
      if (q.whenTrue !== undefined || q.whenFalse !== undefined) {
        wire['criteria'] = { true: q.whenTrue ?? '', false: q.whenFalse ?? '' };
      }
      return wire;
    }
  }
}

function trimState(state: JevState): JevState {
  if (typeof state !== 'string') {
    // Objects keep their named fields, which the docs prefer for multi-part
    // context. Callers build these; none of ours is anywhere near the limit.
    return state;
  }
  return state.length > MAX_STATE_CHARS ? `${state.slice(0, MAX_STATE_CHARS)}…` : state;
}

function explainStatus(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'the API key was rejected';
    case 422:
      return 'the questions were rejected as invalid';
    case 429:
      return 'rate limited — not retried inside the routing deadline';
    case 529:
      return 'overloaded — not retried inside the routing deadline';
    default:
      return 'from the System One endpoint';
  }
}

/**
 * Read the answers out of the response.
 *
 * Strict about content on purpose: an answer whose type does not match the
 * question we asked, or whose choice is not one we offered, is dropped rather
 * than coerced. A fabricated decision is worse than no decision.
 */
function parseResult(
  body: unknown,
  questions: JevQuestions,
): { answers: Record<string, JevAnswer>; inputTokens: number; outputTokens: number } | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;

  const raw = root['answers'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const byId = raw as Record<string, unknown>;

  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const entry = byId[id];
    if (!entry || typeof entry !== 'object') continue;
    const answer = readAnswer(entry as Record<string, unknown>, question);
    if (answer) answers[id] = answer;
  }

  if (Object.keys(answers).length === 0) return null;

  const usage = (root['usage'] ?? {}) as Record<string, unknown>;
  return {
    answers,
    inputTokens: typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0,
    outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0,
  };
}

function readAnswer(a: Record<string, unknown>, question: JevQuestion): JevAnswer | null {
  // The response echoes the type. A mismatch means we would be reading the
  // wrong field, so treat it as no answer at all.
  if (typeof a['type'] === 'string' && a['type'] !== question.kind) return null;

  switch (question.kind) {
    case 'choice': {
      const picked = a['choice'];
      if (typeof picked !== 'string') return null;
      // Only a key we actually offered. Jev returns the key, not the prose.
      if (!Object.prototype.hasOwnProperty.call(question.options, picked)) return null;
      return {
        type: 'choice',
        choice: picked,
        confidence: readConfidence(a),
        probabilities: readProbabilities(a),
      };
    }
    case 'score': {
      const value = a['score'];
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const top = question.levels.length - 1;
      return {
        type: 'score',
        score: Math.max(0, Math.min(top, value)),
        confidence: readConfidence(a),
        probabilities: readProbabilities(a),
        levels: question.levels.length,
      };
    }
    case 'noul': {
      const value = a['noul'];
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return { type: 'noul', noul: clamp01(value) };
    }
  }
}

/** Missing confidence is treated as unusable rather than certain. */
function readConfidence(a: Record<string, unknown>): number {
  return typeof a['confidence'] === 'number' ? clamp01(a['confidence']) : 0;
}

function readProbabilities(a: Record<string, unknown>): Record<string, number> {
  const raw = a['probabilities'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * A choice that cleared the floor and is one of `allowed`, or null.
 *
 * Confidence summarises how concentrated the distribution is — not permission
 * to act. Callers decide what a low-confidence answer costs them.
 */
export function confidentChoice(
  result: JevResult | null,
  id: string,
  allowed: readonly string[],
  floor: number = JEV_CONFIDENCE_FLOOR,
): { value: string; confidence: number } | null {
  const answer = result?.answers[id];
  if (!answer || answer.type !== 'choice') return null;
  if (answer.confidence < floor) return null;
  const match = allowed.find((a) => a === answer.choice);
  return match ? { value: match, confidence: answer.confidence } : null;
}

/**
 * A score's nearest level, or null when Jev is not sure enough.
 *
 * `exact` is the probability-weighted mean; `level` is the level a caller that
 * needs a single bucket should use.
 */
export function confidentScore(
  result: JevResult | null,
  id: string,
  floor: number = JEV_CONFIDENCE_FLOOR,
): { level: number; exact: number; confidence: number } | null {
  const answer = result?.answers[id];
  if (!answer || answer.type !== 'score') return null;
  if (answer.confidence < floor) return null;
  return {
    level: Math.round(answer.score),
    exact: answer.score,
    confidence: answer.confidence,
  };
}

/**
 * Whether a noul cleared `threshold`, or null if it was not answered.
 *
 * A noul near 0.5 means yes and no are about equally likely — not "medium".
 */
export function likely(
  result: JevResult | null,
  id: string,
  threshold = 0.5,
): boolean | null {
  const answer = result?.answers[id];
  if (!answer || answer.type !== 'noul') return null;
  return answer.noul >= threshold;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

let warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  // Loud once, then quiet: a degraded router must not flood the logs.
  console.warn(message);
}

/** Test seam. */
export function __resetJevWarnings(): void {
  warned = new Set();
}
