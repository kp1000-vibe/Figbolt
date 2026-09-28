import { and, eq } from 'drizzle-orm';
import { evalCases, type Grader, type LearningTask } from '@/db/schema';
import { scope, type Ctx } from '../context';

/**
 * The corpus has to start somewhere.
 *
 * Every case below is a behaviour that was actually wrong at some point during
 * development and was fixed — the objection extractor firing on our own
 * outbound email, commitments swallowing requirements, churn language going
 * undetected offline. They were verified once by a person reading real output,
 * which is exactly the standard the usage-grown cases are held to.
 *
 * This is the literal sense in which the test suite is part of the learning
 * loop: the same assertions live in `tests/` as fast unit checks and here as
 * replayable cases scored on every run, so a regression shows up as a falling
 * pass rate and a proposal rather than only as a red test.
 *
 * Idempotent — re-running adds nothing.
 */

type Seed = {
  task: LearningTask;
  inputText: string;
  expected: Record<string, unknown>;
  grader: Grader;
  label: string;
  isCustomer?: boolean;
};

const SEEDS: Seed[] = [
  /* ── Objections: over-firing was the worst offender ─────────────────────── */
  {
    task: 'extract_objections',
    inputText:
      "I'll approve the budget on my side — I have discretion up to this level, so we don't need to involve the board.",
    expected: {},
    grader: 'empty',
    label: 'budget discretion is a buying signal, not a concern',
  },
  {
    task: 'extract_objections',
    inputText:
      'Please send the SOC 2 Type II report (current period) 2. the penetration test summary 3. your subprocessor list',
    expected: {},
    grader: 'empty',
    label: 'an enumerated document request is not an objection',
  },
  {
    task: 'extract_objections',
    inputText:
      "Before we get into that — our security team needs SOC 2 Type II documentation. That's a hard requirement before procurement can even open a file.",
    expected: { category: 'security' },
    grader: 'category',
    label: 'a hard security requirement is a security objection',
  },
  {
    task: 'extract_objections',
    inputText:
      "Honestly, we don't need another tool — we already have three nobody opens.",
    expected: { category: 'need' },
    grader: 'category',
    label: 'a real lack of need is a need objection',
  },
  {
    task: 'extract_objections',
    inputText:
      "To be straight with you, we'll be comparing you side by side with the incumbent before anyone signs.",
    expected: { category: 'competitor' },
    grader: 'category',
    label: 'contractions must not defeat competitor detection',
  },

  /* ── Commitments ────────────────────────────────────────────────────────── */
  {
    task: 'extract_commitments',
    inputText:
      "Yes — I'll send the security questionnaire and our SOC 2 Type II report by Friday.",
    expected: { contains: ['security', 'questionnaire'] },
    grader: 'contains',
    label: 'a promise with a deadline is a commitment',
    isCustomer: false,
  },
  {
    task: 'extract_commitments',
    inputText:
      'Anything we adopt has to go through our security review, and that process is not fast.',
    expected: {},
    grader: 'empty',
    label: 'a stated requirement is not a commitment',
  },

  /* ── Churn: invisible offline until it was built ────────────────────────── */
  {
    task: 'extract_product_signals',
    inputText:
      'I have a renewal conversation with procurement in November and right now I cannot justify it. We are going to have to seriously reconsider at renewal unless something changes on the mobile side.',
    expected: {},
    grader: 'non_empty',
    label: 'conditional renewal language is a churn risk',
  },
  {
    task: 'extract_product_signals',
    inputText:
      'We will not be renewing our contract next year.',
    expected: {},
    grader: 'non_empty',
    label: 'an explicit non-renewal is a churn risk',
  },
  {
    task: 'extract_product_signals',
    inputText:
      'The bulk export times out above about eight thousand rows. Can you take a look?',
    expected: { category: 'bug' },
    grader: 'category',
    label: 'a defect report classifies as a bug, not churn',
  },
  {
    task: 'extract_product_signals',
    inputText:
      'We would hate for you to cancel your subscription over this, so let me escalate it today.',
    expected: {},
    grader: 'empty',
    label: 'our own outbound reassurance is not a customer churn signal',
    isCustomer: false,
  },
  {
    task: 'extract_product_signals',
    inputText:
      'Is SCIM available on our plan, or do we need to move up a tier? We are onboarding two more campuses in October.',
    expected: { category: 'security_requirement' },
    grader: 'category',
    label: 'SCIM provisioning is a security requirement',
  },

  /* ── Meeting transcripts ────────────────────────────────────────────────
   * Spoken language is not written language, and the meeting pipeline feeds
   * the same extractors as email. These cases exist because a transcript
   * breaks the assumptions email does not: people hedge, interrupt, think out
   * loud, and the speaker attribution decides whether a sentence is a
   * customer's concern or our own rep's reassurance.
   */
  {
    task: 'extract_commitments',
    inputText:
      "Right, so I'll get the updated pricing over to you before Friday and I'll loop in our security lead on the questionnaire.",
    expected: { contains: ['pricing'] },
    grader: 'contains',
    label: 'meeting: two promises in one spoken sentence',
    isCustomer: false,
  },
  {
    task: 'extract_commitments',
    inputText:
      "I mean, we could send over the pricing at some point, I suppose, if that would be useful to you at all.",
    expected: {},
    grader: 'empty',
    label: 'meeting: hedged musing is not a commitment',
    isCustomer: false,
  },
  {
    task: 'extract_commitments',
    inputText:
      'We will have the procurement paperwork back to you by the end of next week, once legal has had a look.',
    expected: { contains: ['procurement'] },
    grader: 'contains',
    label: 'meeting: the customer can make a commitment too',
  },
  {
    task: 'extract_objections',
    inputText:
      "Honestly the price is the sticking point for us — at that number it is hard to get it past our CFO this quarter.",
    expected: { category: 'price' },
    grader: 'category',
    label: 'meeting: spoken price resistance is a price objection',
  },
  {
    task: 'extract_objections',
    inputText:
      "So just to play back what I heard — the concern is the cost, and you need data residency in the EU. Have I got that right?",
    expected: {},
    grader: 'empty',
    label: 'meeting: a rep summarising the concern back is not a new objection',
    isCustomer: false,
  },
  {
    task: 'extract_objections',
    inputText:
      'We are already fairly deep into an evaluation with one of your competitors, so this would have to be clearly better.',
    expected: { category: 'competitor' },
    grader: 'category',
    label: 'meeting: an in-flight competitive evaluation is a competitor objection',
  },
  {
    task: 'extract_product_signals',
    inputText:
      "If we are being blunt, unless the Salesforce sync lands before renewal I do not think we can justify keeping this.",
    expected: {},
    grader: 'non_empty',
    label: 'meeting: a feature gap tied to renewal is a signal, not silence',
  },
  {
    task: 'extract_product_signals',
    inputText:
      'The export button just crashes the whole settings page in Safari. Works fine in Chrome, but half our team is on Safari.',
    expected: { category: 'bug' },
    grader: 'category',
    label: 'meeting: a reproducible crash is a bug',
  },
  {
    task: 'extract_facts',
    inputText:
      'We are about four hundred people now, mostly in Manchester, and the whole revenue team sits in one office.',
    expected: {},
    grader: 'non_empty',
    label: 'meeting: headcount and location stated out loud are facts',
  },
];

export async function bootstrapEvalCases(ctx: Ctx): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;

  for (const seed of SEEDS) {
    const [already] = await ctx.db
      .select({ id: evalCases.id })
      .from(evalCases)
      .where(and(scope(ctx, evalCases), eq(evalCases.label, seed.label)))
      .limit(1);

    if (already) {
      existing++;
      continue;
    }

    await ctx.db.insert(evalCases).values({
      workspaceId: ctx.workspaceId,
      task: seed.task,
      inputText: seed.inputText,
      inputMeta: { isCustomer: seed.isCustomer ?? true },
      expected: seed.expected,
      grader: seed.grader,
      origin: 'test',
      label: seed.label,
    });
    created++;
  }

  return { created, existing };
}
