import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_shared';
import { users, workspaces } from './identity';
import type { Role } from './identity';
import type { SourceRef } from './crm';

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type AgentTrigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; cron: string; timezone: string; label?: string }
  | { kind: 'event'; event: string; filter?: Record<string, unknown> }
  | { kind: 'webhook'; secretRef?: string };

export type AgentOutputField = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
  description: string;
  required?: boolean;
};

export type ApprovalPolicy = {
  /** Risk levels this agent may execute without a human. */
  autoApprove: RiskLevel[];
  /** Who receives the approval request. */
  notify: 'owner' | 'record_owner' | 'workspace_admins';
  /** Approvals expire so stale proposals never fire late. */
  expiresAfterHours: number;
};

export const agents = pgTable(
  'agents',
  {
    id: primaryId('agt'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** The natural-language spec the user typed, kept verbatim for re-compilation. */
    prompt: text('prompt').notNull(),
    /** Compiled operating instructions handed to the model as system context. */
    instructions: text('instructions').notNull(),
    trigger: jsonb('trigger').$type<AgentTrigger>().notNull(),
    /** Allow-list of tool names. The runtime rejects anything not listed. */
    toolNames: jsonb('tool_names').$type<string[]>().notNull().default([]),
    /** Structured plan shown in the visual builder. */
    steps: jsonb('steps').$type<AgentStepSpec[]>().notNull().default([]),
    filters: jsonb('filters').$type<Record<string, unknown>>(),
    outputSchema: jsonb('output_schema').$type<AgentOutputField[]>().notNull().default([]),
    approvalPolicy: jsonb('approval_policy').$type<ApprovalPolicy>().notNull(),
    /**
     * The agent acts as this user. Tool permission checks resolve against
     * their role, so an agent can never exceed its authorizer.
     */
    runAsUserId: text('run_as_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Snapshot of the authorizing role, re-checked at run time. */
    maxRole: text('max_role').$type<Role>().notNull().default('member'),
    knowledgeScope: jsonb('knowledge_scope').$type<string[]>().notNull().default([]),
    /** Durable cross-run scratchpad, e.g. "accounts already emailed". */
    memory: jsonb('memory').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    isSystem: boolean('is_system').notNull().default(false),
    lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('agents_ws_idx').on(t.workspaceId, t.deletedAt),
    index('agents_ws_next_run_idx').on(t.workspaceId, t.enabled, t.nextRunAt),
  ],
);

export type AgentStepSpec = {
  id: string;
  kind: 'retrieve' | 'analyze' | 'tool' | 'decide' | 'act' | 'notify';
  title: string;
  detail?: string;
  tool?: string;
  params?: Record<string, unknown>;
};

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: primaryId('run'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    triggerKind: text('trigger_kind').notNull(),
    triggerDetail: text('trigger_detail'),
    triggeredById: text('triggered_by_id').references(() => users.id, { onDelete: 'set null' }),
    input: jsonb('input').$type<Record<string, unknown>>(),
    /** Conforms to the agent's `outputSchema` when the run succeeds. */
    output: jsonb('output').$type<Record<string, unknown>>(),
    /** Short, user-facing recap. Never raw chain-of-thought. */
    summary: text('summary'),
    sources: jsonb('sources').$type<SourceRef[]>().notNull().default([]),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    stepCount: integer('step_count').notNull().default(0),
    model: text('model'),
    ...timestamps,
  },
  (t) => [
    index('agent_runs_ws_agent_idx').on(t.workspaceId, t.agentId, t.createdAt),
    index('agent_runs_ws_status_idx').on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const agentRunSteps = pgTable(
  'agent_run_steps',
  {
    id: primaryId('step'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    kind: text('kind')
      .$type<'plan' | 'retrieve' | 'tool_call' | 'model_call' | 'approval' | 'result' | 'error'>()
      .notNull(),
    title: text('title').notNull(),
    tool: text('tool'),
    /** Persisted verbatim so a run is fully replayable and auditable. */
    input: jsonb('input').$type<unknown>(),
    output: jsonb('output').$type<unknown>(),
    status: text('status')
      .$type<'ok' | 'error' | 'skipped' | 'awaiting_approval' | 'denied'>()
      .notNull()
      .default('ok'),
    error: text('error'),
    riskLevel: text('risk_level').$type<RiskLevel>(),
    sources: jsonb('sources').$type<SourceRef[]>().notNull().default([]),
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [index('agent_run_steps_run_idx').on(t.runId, t.index)],
);

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'executed'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * A proposed side effect awaiting a human decision.
 *
 * `payload` is the *exact* typed tool input that will execute on approval -
 * the UI renders it, and the executor re-reads it from the row rather than
 * trusting anything the model says later.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: primaryId('apr'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => agentRunSteps.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    automationRunId: text('automation_run_id'),
    tool: text('tool').notNull(),
    riskLevel: text('risk_level').$type<RiskLevel>().notNull(),
    title: text('title').notNull(),
    rationale: text('rationale'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Rendered preview (email body, field diff) so approvers see the real thing. */
    preview: jsonb('preview').$type<ApprovalPreview>(),
    sources: jsonb('sources').$type<SourceRef[]>().notNull().default([]),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    requestedForId: text('requested_for_id').references(() => users.id, { onDelete: 'set null' }),
    decidedById: text('decided_by_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionNote: text('decision_note'),
    /** Edited payload when the approver changed the proposal before sending. */
    editedPayload: jsonb('edited_payload').$type<Record<string, unknown>>(),
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' }),
    executionResult: jsonb('execution_result').$type<Record<string, unknown>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('approvals_ws_status_idx').on(t.workspaceId, t.status, t.createdAt),
    index('approvals_ws_run_idx').on(t.workspaceId, t.runId),
    index('approvals_ws_for_idx').on(t.workspaceId, t.requestedForId, t.status),
  ],
);

export type ApprovalPreview =
  | { kind: 'email'; to: string[]; cc?: string[]; subject: string; body: string }
  | { kind: 'record_diff'; recordType: string; recordId: string; recordLabel: string; changes: FieldChange[] }
  | { kind: 'bulk'; description: string; itemCount: number; items: { label: string; detail?: string }[] }
  | { kind: 'text'; body: string };

export type FieldChange = { field: string; label: string; from: unknown; to: unknown };
