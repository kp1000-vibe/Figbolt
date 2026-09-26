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
