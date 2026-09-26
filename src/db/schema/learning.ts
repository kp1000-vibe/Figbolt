import { boolean, index, integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_shared';
import { users, workspaces } from './identity';
import { approvals } from './agents';

/**
 * The learning loop.
 *
 * Every judgement a human makes about the engine's output is already happening
 * — approving an agent's proposed email, editing its payload before sending,
 * superseding a fact it derived, rating an answer. Those judgements were
 * previously thrown away once the action completed. Here they are captured as
 * `feedback_signals`, distilled into `eval_cases` with a known-correct answer,
 * and replayed against the current engine on every `eval_runs` pass.
 *
 * The part that makes it a loop rather than a dashboard: a run that finds a
 * cluster of failures drafts an `improvement_proposals` row describing the
 * concrete change, and that proposal goes through the same human approval gate
 * as any other high-risk action. Nothing rewrites the engine unattended — a
 * silent change to extraction rules would degrade every downstream surface
 * with no one noticing, which is precisely the failure this product exists to
 * prevent.
 */

/** Which engine capability a signal or case judges. */
export const LEARNING_TASKS = [
  'extract_commitments',
  'extract_objections',
  'extract_product_signals',
  'extract_facts',
  'answer_question',
  'draft_email',
  'score_deal_health',
  'tool_choice',
  'summarize',
] as const;
export type LearningTask = (typeof LEARNING_TASKS)[number];

export const SIGNAL_KINDS = [
  /** A human approved or rejected a proposed action. */
  'approval_decision',
  /** A human approved but rewrote the payload first — the edit is the label. */
  'payload_edit',
  /** A human superseded a fact the engine derived. */
  'fact_correction',
  /** A human rated an answer useful or not. */
  'answer_rating',
  /** A human dismissed an extracted concern or commitment as wrong. */
  'extraction_rejected',
  /** Authored directly by a developer, or imported from the test suite. */
  'authored',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const feedbackSignals = pgTable(
  'feedback_signals',
  {
    id: primaryId('sig'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SignalKind>().notNull(),
    task: text('task').$type<LearningTask>().notNull(),
    /**
     * `positive` — the engine was right and a human acted on it unchanged.
     * `negative` — the engine was wrong and a human refused it.
     * `corrected` — the engine was close and a human fixed it; `humanOutput`
     * holds the correction, which is the most valuable label of the three.
     */
    verdict: text('verdict').$type<'positive' | 'negative' | 'corrected'>().notNull(),

    /** What was judged, for linking back into the CRM. */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    /** The raw evidence the engine read, so a case can replay the real input. */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    inputText: text('input_text'),

    modelOutput: jsonb('model_output').$type<unknown>(),
    humanOutput: jsonb('human_output').$type<unknown>(),
    note: text('note'),

    /** What the engine claimed at the time, for calibration analysis. */
    confidence: real('confidence'),
    model: text('model'),

    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /** Set once this signal has been distilled into an eval case. */
    promotedCaseId: text('promoted_case_id'),
    ...timestamps,
  },
  (t) => [
    index('feedback_signals_ws_task_idx').on(t.workspaceId, t.task, t.occurredAt),
    index('feedback_signals_ws_unpromoted_idx').on(t.workspaceId, t.promotedCaseId),
  ],
);

/** How a case's expected value is compared against what the engine produced. */
export const GRADERS = [
  /** Every string in `expected.contains` must appear in the output. */
  'contains',
  /** `expected.category` must equal the output's category. */
  'category',
  /** The output must be non-empty — used for "it should find something". */
  'non_empty',
  /** The output must be empty — used for "it should not over-fire". */
  'empty',
  /** `expected.min`/`max` bound a numeric output. */
  'numeric_range',
] as const;
export type Grader = (typeof GRADERS)[number];

export const evalCases = pgTable(
  'eval_cases',
  {
    id: primaryId('evc'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    task: text('task').$type<LearningTask>().notNull(),

    /** The exact text the engine must handle, replayed verbatim. */
    inputText: text('input_text').notNull(),
    /** Speaker, isCustomer and anything else the extractor reads. */
    inputMeta: jsonb('input_meta').$type<Record<string, unknown>>().notNull().default({}),

    expected: jsonb('expected').$type<Record<string, unknown>>().notNull(),
    grader: text('grader').$type<Grader>().notNull(),

    /** Where the ground truth came from, so a bad case can be traced. */
    origin: text('origin').$type<'usage' | 'test' | 'authored'>().notNull(),
    originSignalId: text('origin_signal_id'),
    label: text('label').notNull(),

    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('eval_cases_ws_task_idx').on(t.workspaceId, t.task, t.enabled)],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: primaryId('evr'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    trigger: text('trigger').$type<'manual' | 'scheduled' | 'ci' | 'post_change'>().notNull(),
    model: text('model').notNull(),

    totalCases: integer('total_cases').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** Pass rate per task, so a regression can be attributed. */
    scoreByTask: jsonb('score_by_task')
      .$type<Record<string, { passed: number; total: number }>>()
      .notNull()
      .default({}),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    latencyMs: integer('latency_ms'),
    ...timestamps,
  },
  (t) => [index('eval_runs_ws_started_idx').on(t.workspaceId, t.startedAt)],
);

export const evalResults = pgTable(
  'eval_results',
  {
    id: primaryId('evx'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    task: text('task').$type<LearningTask>().notNull(),
    passed: boolean('passed').notNull(),
    actual: jsonb('actual').$type<unknown>(),
    /** Why it failed, in the words the grader used. */
    detail: text('detail'),
    latencyMs: integer('latency_ms'),
    ...timestamps,
  },
  (t) => [
    index('eval_results_run_idx').on(t.runId, t.passed),
    index('eval_results_case_idx').on(t.caseId),
  ],
);

export const improvementProposals = pgTable(
  'improvement_proposals',
  {
    id: primaryId('imp'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => evalRuns.id, { onDelete: 'set null' }),
    task: text('task').$type<LearningTask>().notNull(),

    title: text('title').notNull(),
    /** Why the loop thinks this change helps, in evidence terms. */
    rationale: text('rationale').notNull(),
    /** The file and symbol a human would edit. */
    target: text('target').notNull(),
    /** Structured description of the change, never executable code. */
    change: jsonb('change').$type<Record<string, unknown>>().notNull(),
    failingCaseIds: jsonb('failing_case_ids').$type<string[]>().notNull().default([]),

    status: text('status')
      .$type<'proposed' | 'approved' | 'rejected' | 'applied' | 'superseded'>()
      .notNull()
      .default('proposed'),
    /** The approval this proposal is waiting on, if it has been raised. */
    approvalId: text('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    decidedById: text('decided_by_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [index('improvement_proposals_ws_status_idx').on(t.workspaceId, t.status)],
);
