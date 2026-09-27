import { env } from '@/lib/env';

/**
 * Jev — a System One decision model from TypeSafe AI.
 *
 * Jev is not an LLM and never writes text. You hand it a state plus typed
 * questions and it hands back decisions, in one parallel pass, in roughly
 * 70–500ms. Input costs $0.042 per million tokens and output is free, which is
 * what makes it viable in places a chat model was always too slow and too
 * expensive to sit — like deciding, per request, which model should do the
 * actual work.
 *
 * Three answer shapes, and only three:
 *
 *   choice  pick one of the options you supply
 *   score   place it on a scale you define
 *   noul    the probability a statement is true
 *
 * Two rules from TypeSafe's own guidance, both enforced here rather than left
 * to the caller's discretion:
 *
 *   1. **Jev decides, the writer writes.** Nothing in this module produces
 *      prose, and the router it feeds never lets Jev author anything.
 *   2. **Below 0.6 confidence, the caller decides.** Jev is weak at maths,
 *      dates, counting and long input padded with irrelevant text, so a
 *      low-confidence answer is treated as no answer at all.
 *
 * Every call is wrapped so that a slow, missing or broken Jev is
 * indistinguishable from Jev being switched off. A router that can stall the
 * CRM is worse than no router.
 */

export const JEV_MODEL_ID = 'typesafe/jev-1.13';
const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

/** Below this, TypeSafe's guidance is to let the caller decide instead. */
export const JEV_CONFIDENCE_FLOOR = 0.6;

/** Jev answers in ~0.3s. Anything past this is a fault, not slowness. */
const TIMEOUT_MS = 1200;

/** $0.042 per 1M input tokens; output is free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export type JevQuestion =
  | { id: string; kind: 'choice'; question: string; options: string[] }
  | { id: string; kind: 'score'; question: string; min: number; max: number }
  | { id: string; kind: 'noul'; question: string };

export type JevAnswer = {
  id: string;
  /** The picked option, the score, or the probability, by question kind. */
  value: string | number;
  confidence: number;
};

export type JevResult = {
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
};

export function jevConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

/**
 * Ask Jev a set of typed questions about one state.
 *
 * Returns null — never throws — when Jev is not configured, times out, errors,
 * or answers in a shape we do not recognise. Every caller treats null as
 * "decide it yourself".
 */
export async function askJev(
  state: string,
  questions: JevQuestion[],
): Promise<JevResult | null> {
  const key = env.OPENROUTER_API_KEY;
  if (!key || questions.length === 0) return null;

  // Jev takes 64K per request with 32K for the state, and is explicitly weak
  // on long input padded with irrelevant text. Truncating beats degrading.
  const trimmed = state.length > 24_000 ? `${state.slice(0, 24_000)}…` : state;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL_ID,
        state: trimmed,
        questions: questions.map(toWireQuestion),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      warnOnce(`[jev] ${res.status} from the decisions endpoint; routing falls back`);
      return null;
    }

    const body = (await res.json()) as unknown;
    const answers = parseAnswers(body, questions);
    if (!answers) {
      warnOnce('[jev] unrecognised response shape; routing falls back');
      return null;
    }

    const inputTokens = estimateTokens(trimmed, questions);
    return {
      answers,
      latencyMs: Date.now() - started,
      inputTokens,
      costUsd: inputTokens * USD_PER_INPUT_TOKEN,
    };
  } catch (err) {
    // An abort is the expected failure, not an exceptional one.
    const aborted = (err as Error).name === 'AbortError';
    warnOnce(
      aborted
        ? `[jev] no answer within ${TIMEOUT_MS}ms; routing falls back`
        : `[jev] unreachable (${(err as Error).message}); routing falls back`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toWireQuestion(q: JevQuestion): Record<string, unknown> {
  switch (q.kind) {
    case 'choice':
      return { id: q.id, type: 'choice', question: q.question, options: q.options };
    case 'score':
      return { id: q.id, type: 'score', question: q.question, scale: { min: q.min, max: q.max } };
    case 'noul':
      return { id: q.id, type: 'noul', question: q.question };
  }
}

/**
 * Read the answers out of whatever the endpoint returned.
 *
 * Deliberately permissive about envelope shape and strict about content. Jev
 * launched in September 2026 on a new OpenRouter route, so the envelope may
 * move; what must not move is that an answer carries a value and a confidence.
 * A malformed answer is dropped rather than coerced, because a fabricated
 * routing decision is worse than no routing decision.
 */
function parseAnswers(
  body: unknown,
  questions: JevQuestion[],
): Record<string, JevAnswer> | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;

  const raw =
    (Array.isArray(root['answers']) && root['answers']) ||
    (Array.isArray(root['decisions']) && root['decisions']) ||
    (Array.isArray(root['results']) && root['results']) ||
    null;
  if (!raw) return null;

  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: Record<string, JevAnswer> = {};

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const id = typeof a['id'] === 'string' ? a['id'] : null;
    if (!id || !byId.has(id)) continue;

    const value = a['value'] ?? a['answer'] ?? a['choice'] ?? a['score'] ?? a['probability'];
    if (typeof value !== 'string' && typeof value !== 'number') continue;

    const confidence =
      typeof a['confidence'] === 'number'
        ? a['confidence']
        : typeof a['certainty'] === 'number'
          ? a['certainty']
          : // No confidence reported: treat as unusable rather than certain.
            0;

    out[id] = { id, value, confidence: clamp01(confidence) };
  }

  return Object.keys(out).length > 0 ? out : null;
}

/** A choice answer that cleared the floor, or null. */
export function confidentChoice(
  result: JevResult | null,
  id: string,
  allowed: readonly string[],
): { value: string; confidence: number } | null {
  const answer = result?.answers[id];
  if (!answer || typeof answer.value !== 'string') return null;
  if (answer.confidence < JEV_CONFIDENCE_FLOOR) return null;
  const value = answer.value.trim().toLowerCase();
  const match = allowed.find((a) => a.toLowerCase() === value);
  return match ? { value: match, confidence: answer.confidence } : null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Rough token count, for cost accounting only. */
function estimateTokens(state: string, questions: JevQuestion[]): number {
  const questionChars = questions.reduce(
    (n, q) => n + q.question.length + ('options' in q ? q.options.join('').length : 0),
    0,
  );
  return Math.ceil((state.length + questionChars) / 4);
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
