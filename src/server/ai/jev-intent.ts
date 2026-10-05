import { askJev, choice, confidentChoice, noul, type JevQuestions } from '@/lib/ai/jev';
import { jevMayRead } from '@/lib/ai/jev-first';
import type { SearchScope } from '../retrieval/search';

/**
 * Classify an Ask Bolt question with Jev — no LLM involved.
 *
 * Every question asked goes through classification first, and it is a pure
 * decision: which of five intents, which record types to search, what period.
 * Jev answers all of it in one parallel pass. When Jev is not confident about
 * the intent, this returns null and the caller asks an LLM instead.
 *
 * The question is the signed-in user's own words, so this only runs when
 * JEV_SEND_CONTENT allows Jev to read operator text.
 */

export type JevIntent = {
  intent: 'search' | 'explain' | 'analytics' | 'draft' | 'mutate';
  scopes: SearchScope[];
  timeframeDays: number;
  confidence: number;
  jevLatencyMs: number;
  jevCostUsd: number;
};

/** Option meanings live in criteria, not in the instruction. */
const INTENTS = {
  search: 'Find or look up specific records, people, emails, meetings or what someone said.',
  explain: 'Understand why something happened, or the state of a relationship or deal; needs reasoning over evidence.',
  analytics: 'Counts, totals, rankings, trends or lists across many records, such as which deals are at risk or pipeline by stage.',
  draft: 'Write something: an email, a follow-up, a message or a summary to send.',
  mutate: 'Change a record: create, update, move, assign, close or delete something.',
} as const;

const TIMEFRAMES = {
  all_time: 'No time period is mentioned or implied.',
  last_week: 'Today, yesterday, this week or the last few days.',
  last_month: 'This month or the last few weeks.',
  last_quarter: 'This quarter or the last few months.',
  last_year: 'This year or last year.',
} as const;

const TIMEFRAME_DAYS: Record<keyof typeof TIMEFRAMES, number> = {
  all_time: 0,
  last_week: 7,
  last_month: 30,
  last_quarter: 90,
  last_year: 365,
};

/**
 * One yes/no per group of record types. Grouped so Jev is asked about things
 * a person would distinguish; each group expands to the scopes it covers.
 */
const SCOPE_GROUPS: { id: string; question: string; scopes: SearchScope[] }[] = [
  { id: 'emails', question: 'Does answering this need emails?', scopes: ['emails'] },
  { id: 'meetings', question: 'Does answering this need meetings, calls or what was said in them?', scopes: ['meetings', 'transcripts'] },
  { id: 'deals', question: 'Is this about deals, pipeline, revenue or sales opportunities?', scopes: ['opportunities', 'crm_events'] },
  { id: 'people', question: 'Is this about specific companies or people?', scopes: ['accounts', 'contacts'] },
  { id: 'follow_ups', question: 'Is this about tasks, follow-ups or promises someone made?', scopes: ['tasks', 'commitments'] },
  { id: 'concerns', question: 'Is this about objections, concerns or risks customers raised?', scopes: ['objections'] },
  { id: 'requests', question: 'Is this about product feedback or feature requests?', scopes: ['product_signals'] },
  { id: 'notes', question: 'Does this need internal notes or written knowledge?', scopes: ['notes', 'knowledge'] },
];

/**
 * Inclusion bar for a scope. Deliberately below 0.5: searching one record type
 * too many costs a little latency, while missing one means a missed answer.
 */
const SCOPE_INCLUDE_AT = 0.35;

/**
 * Always searched, whatever Jev says. In a live test Jev did not flag emails
 * for "What did Acme say about pricing?" — exactly where that answer lives.
 * Searching a core record type needlessly costs milliseconds; skipping one
 * loses the answer. So Jev's scope answers only ever *add* the specialised
 * record types on top of these.
 */
const CORE: SearchScope[] = ['accounts', 'opportunities', 'emails', 'meetings', 'transcripts'];

export async function classifyIntentWithJev(question: string): Promise<JevIntent | null> {
  if (!jevMayRead('operator_text')) return null;

  const questions: JevQuestions = {
    intent: choice('What does the person asking want?', INTENTS),
    timeframe: choice('What period of time does the question cover?', TIMEFRAMES),
  };
  for (const group of SCOPE_GROUPS) questions[`scope_${group.id}`] = noul(group.question);

  const result = await askJev({ question: question.slice(0, 2000), product: 'a CRM for small businesses' }, questions);
  if (!result) return null;

  const intent = confidentChoice(result, 'intent', Object.keys(INTENTS));
  // Not sure what they want: the LLM makes the call, not a guess.
  if (!intent) return null;

  // An unsure timeframe falls back to all time — the broad, safe reading.
  const timeframe = confidentChoice(result, 'timeframe', Object.keys(TIMEFRAMES));
  const timeframeDays = timeframe ? TIMEFRAME_DAYS[timeframe.value as keyof typeof TIMEFRAMES] : 0;

  const scopes = new Set<SearchScope>(CORE);
  for (const group of SCOPE_GROUPS) {
    const answer = result.answers[`scope_${group.id}`];
    if (answer?.type === 'noul' && answer.noul >= SCOPE_INCLUDE_AT) {
      for (const s of group.scopes) scopes.add(s);
    }
  }

  return {
    intent: intent.value as JevIntent['intent'],
    scopes: [...scopes],
    timeframeDays,
    confidence: intent.confidence,
    jevLatencyMs: result.latencyMs,
    jevCostUsd: result.costUsd,
  };
}
