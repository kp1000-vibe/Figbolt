import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps, tsvector } from './_shared';
import { users, workspaces } from './identity';
import { accounts, contacts, opportunities } from './crm';
import { EMBEDDING_DIM } from './memory';
import type { RiskLevel } from './agents';

/* ── Custom objects & fields ──────────────────────────────────────────────── */

export const customObjectTypes = pgTable(
  'custom_object_types',
  {
    id: primaryId('cot'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    pluralName: text('plural_name').notNull(),
    description: text('description'),
    icon: text('icon'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('custom_object_types_key').on(t.workspaceId, t.key)],
);

export const customObjects = pgTable(
  'custom_objects',
  {
    id: primaryId('cob'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    typeId: text('type_id')
      .notNull()
      .references(() => customObjectTypes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('custom_objects_ws_type_idx').on(t.workspaceId, t.typeId)],
);

export const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'date',
  'boolean',
  'select',
  'multi_select',
  'url',
  'email',
  'reference',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Custom field definitions attach to any object kind - the built-in ones
 * ('account', 'contact', 'opportunity') or a custom type key.
 */
export const customFields = pgTable(
  'custom_fields',
  {
    id: primaryId('cf'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectType: text('object_type').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').$type<FieldType>().notNull(),
    options: jsonb('options').$type<string[]>().notNull().default([]),
    referenceType: text('reference_type'),
    description: text('description'),
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull().default(0),
    /** Let the memory engine propose values for this field from conversations. */
    aiFillable: boolean('ai_fillable').notNull().default(false),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('custom_fields_key').on(t.workspaceId, t.objectType, t.key)],
);

export const customFieldValues = pgTable(
  'custom_field_values',
  {
    id: primaryId('cfv'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fieldId: text('field_id')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    recordId: text('record_id').notNull(),
    value: jsonb('value').$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('custom_field_values_key').on(t.workspaceId, t.fieldId, t.recordId),
    index('custom_field_values_record_idx').on(t.workspaceId, t.recordType, t.recordId),
  ],
);

/* ── Knowledge base ───────────────────────────────────────────────────────── */

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: primaryId('kdoc'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    category: text('category')
      .$type<
        | 'product'
        | 'pricing'
        | 'security'
        | 'playbook'
        | 'case_study'
        | 'battlecard'
        | 'methodology'
        | 'onboarding'
        | 'other'
      >()
      .notNull()
      .default('other'),
    content: text('content').notNull(),
    summary: text('summary'),
    sourceUrl: text('source_url'),
    fileKey: text('file_key'),
    mimeType: text('mime_type'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    /** Knowledge is trusted workspace configuration, not untrusted retrieved text. */
    trusted: boolean('trusted').notNull().default(true),
    version: integer('version').notNull().default(1),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    indexedAt: timestamp('indexed_at', { withTimezone: true, mode: 'date' }),
    searchVector: tsvector('search_vector'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('knowledge_documents_ws_idx').on(t.workspaceId, t.category),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: primaryId('kchk'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    heading: text('heading'),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    tokenCount: integer('token_count'),
    searchVector: tsvector('search_vector'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('knowledge_chunks_doc_idx_key').on(t.documentId, t.chunkIndex),
    index('knowledge_chunks_ws_idx').on(t.workspaceId),
  ],
);

/* ── Automations ──────────────────────────────────────────────────────────── */

export type AutomationTrigger =
  | { kind: 'event'; event: AutomationEvent }
  | { kind: 'schedule'; cron: string; timezone: string }
  | { kind: 'webhook'; secretRef?: string };

export const AUTOMATION_EVENTS = [
  'email.received',
  'email.sent',
  'meeting.created',
  'meeting.completed',
  'opportunity.stage_changed',
  'opportunity.inactive',
  'contact.created',
  'account.sentiment_dropped',
  'commitment.due_soon',
  'task.completed',
] as const;
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];

export type ConditionNode =
  | { op: 'and'; children: ConditionNode[] }
  | { op: 'or'; children: ConditionNode[] }
  | {
      op: 'cmp';
      field: string;
      comparator:
        | 'eq'
        | 'neq'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'contains'
        | 'not_contains'
        | 'is_empty'
        | 'is_not_empty'
        | 'in';
      value?: unknown;
    };

export type AutomationAction = {
  id: string;
  kind:
    | 'ask_ai'
    | 'update_record'
    | 'create_task'
    | 'draft_email'
    | 'send_slack'
    | 'run_agent'
    | 'call_webhook'
    | 'add_note';
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
};

export const automations = pgTable(
  'automations',
  {
    id: primaryId('auto'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    trigger: jsonb('trigger').$type<AutomationTrigger>().notNull(),
    conditions: jsonb('conditions').$type<ConditionNode | null>(),
    actions: jsonb('actions').$type<AutomationAction[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    runCount: integer('run_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('automations_ws_enabled_idx').on(t.workspaceId, t.enabled),
    index('automations_ws_next_run_idx').on(t.workspaceId, t.nextRunAt),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: primaryId('arun'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<'succeeded' | 'failed' | 'skipped' | 'awaiting_approval' | 'running'>()
      .notNull()
      .default('running'),
    triggerPayload: jsonb('trigger_payload').$type<Record<string, unknown>>(),
    conditionResult: boolean('condition_result'),
    actionResults: jsonb('action_results').$type<
      { actionId: string; kind: string; status: string; detail?: string }[]
    >()
      .notNull()
      .default([]),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [index('automation_runs_ws_auto_idx').on(t.workspaceId, t.automationId, t.startedAt)],
);

/* ── Integrations ─────────────────────────────────────────────────────────── */

export const INTEGRATION_PROVIDERS = [
  // Mail
  'gmail',
  'outlook_mail',
  // Calendar
  'google_calendar',
  'outlook_calendar',
  // Meetings and recordings
  'zoom',
  'google_meet',
  'ms_teams',
  // Notetakers - these produce the transcripts the memory engine reads
  'granola',
  'fathom',
  'fireflies',
  'otter',
  'gong',
  // Free / open source, self-hosted - no per-minute transcription bill
  'local_whisper',
  'meetily',
  'amurex',
  'jitsi',
  // Scheduling links
  'calendly',
  'cal_com',
  // Calling
  'aircall',
  'dialpad',
  'twilio',
  // Documents and storage
  'google_drive',
  'box',
  'dropbox',
  'onedrive',
  'notion',
  // CRM import
  'hubspot',
  'salesforce',
  'pipedrive',
  'attio',
  'airtable',
  // Support desks
  'zendesk',
  'intercom',
  'front',
  'help_scout',
  // Product analytics
  'posthog',
  'mixpanel',
  'amplitude',
  'segment',
  // Billing and accounting
  'stripe',
  'quickbooks',
  'xero',
  // Messaging and social
  'slack',
  'linkedin',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const integrations = pgTable(
  'integrations',
  {
    id: primaryId('int'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<IntegrationProvider>().notNull(),
    /** Per-user connections (mailboxes) vs workspace-wide (Slack, Salesforce). */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<'connected' | 'disconnected' | 'error' | 'syncing' | 'demo'>()
      .notNull()
      .default('disconnected'),
    mode: text('mode').$type<'live' | 'demo'>().notNull().default('demo'),
    accountLabel: text('account_label'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    /**
     * AES-256-GCM ciphertext, never plaintext. Encrypted with
     * INTEGRATION_TOKEN_KEY - see `src/lib/security/crypto.ts`.
     */
    encryptedTokens: text('encrypted_tokens'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true, mode: 'date' }),
    /** Provider cursor / historyId for incremental sync. */
    syncCursor: text('sync_cursor'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    settings: jsonb('settings').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integrations_ws_provider_user_key').on(t.workspaceId, t.provider, t.userId),
    index('integrations_ws_idx').on(t.workspaceId, t.status),
  ],
);

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: primaryId('sync'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'initial' | 'incremental' | 'webhook' | 'backfill'>().notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'rate_limited'>()
      .notNull()
      .default('queued'),
    recordsProcessed: integer('records_processed').notNull().default(0),
    recordsCreated: integer('records_created').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [index('sync_jobs_ws_integration_idx').on(t.workspaceId, t.integrationId, t.createdAt)],
);

/* ── Audit, notifications, jobs, outbox ───────────────────────────────────── */

/**
 * Append-only. There is deliberately no update/delete path in the repository
 * layer, and the migration revokes UPDATE/DELETE from the application role.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId('aud'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').$type<'user' | 'agent' | 'system' | 'integration'>().notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    riskLevel: text('risk_level').$type<RiskLevel>(),
    /** Field-level before/after for record mutations. */
    changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** Links the action back to the run and approval that authorised it. */
    runId: text('run_id'),
    approvalId: text('approval_id'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_events_ws_occurred_idx').on(t.workspaceId, t.occurredAt),
    index('audit_events_ws_resource_idx').on(t.workspaceId, t.resourceType, t.resourceId),
    index('audit_events_ws_actor_idx').on(t.workspaceId, t.actorType, t.actorId),
  ],
);

export const NOTIFICATION_KINDS = [
  'needs_attention',
  'agent_approval',
  'follow_up',
  'commitment',
  'deal_risk',
  'customer_question',
  'automation_error',
  'mention',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Backs the unified Inbox. Every row must answer what/why/what-next. */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId('ntf'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    title: text('title').notNull(),
    /** "What happened" / "Why it matters" / "What to do" - all three required. */
    whatHappened: text('what_happened').notNull(),
    whyItMatters: text('why_it_matters').notNull(),
    recommendedAction: jsonb('recommended_action').$type<{
      label: string;
      kind: string;
      payload?: Record<string, unknown>;
    }>(),
    severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull().default('info'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    approvalId: text('approval_id'),
    runId: text('run_id'),
    /** Dedupe handle so recurring conditions update rather than pile up. */
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('notifications_ws_user_idx').on(t.workspaceId, t.userId, t.resolvedAt),
    index('notifications_ws_kind_idx').on(t.workspaceId, t.kind, t.createdAt),
    uniqueIndex('notifications_dedupe_key').on(t.workspaceId, t.dedupeKey),
  ],
);

/**
 * Durable job queue. `JOB_RUNNER=inline` drains this in-process; the Inngest
 * adapter publishes the same rows as events. Either way the row is the record
 * of intent, so nothing is lost on restart.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: primaryId('job'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'dead'>()
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('jobs_status_run_at_idx').on(t.status, t.runAt),
    index('jobs_ws_kind_idx').on(t.workspaceId, t.kind),
  ],
);

/** Every outbound message, whether or not a provider actually delivered it. */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: primaryId('out'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    toEmails: jsonb('to_emails').$type<string[]>().notNull(),
    ccEmails: jsonb('cc_emails').$type<string[]>().notNull().default([]),
    fromEmail: text('from_email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status')
      .$type<'draft' | 'queued' | 'sent' | 'failed'>()
      .notNull()
      .default('draft'),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    approvalId: text('approval_id'),
    runId: text('run_id'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('email_outbox_ws_status_idx').on(t.workspaceId, t.status, t.createdAt)],
);

/** Saved list configurations (filters, sort, columns) for CRM table views. */
export const savedViews = pgTable(
  'saved_views',
  {
    id: primaryId('view'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectType: text('object_type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('saved_views_ws_object_idx').on(t.workspaceId, t.objectType)],
);

/** Persisted Ask-AI conversations so answers and citations stay linkable. */
export const conversations = pgTable(
  'conversations',
  {
    id: primaryId('conv'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New conversation'),
    /** Optional record the thread is anchored to ("Ask about this account"). */
    scopeType: text('scope_type'),
    scopeId: text('scope_id'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('conversations_ws_user_idx').on(t.workspaceId, t.userId, t.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: primaryId('msg'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant' | 'system'>().notNull(),
    content: text('content').notNull(),
    /** Structured answer envelope - see `AnswerEnvelope` in src/lib/ai/types.ts. */
    envelope: jsonb('envelope').$type<Record<string, unknown>>(),
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    model: text('model'),
    ...timestamps,
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Fixed-window rate limiter buckets, shared by API routes and agent tools. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('rate_limits_window_idx').on(t.windowStart)],
);

/* ── Programmatic access ──────────────────────────────────────────────────── */

/**
 * API keys for programmatic and agent access.
 *
 * Only a SHA-256 hash is stored, so a leaked database cannot be replayed as
 * credentials and the plaintext is shown exactly once at creation. A key
 * carries its own role, which is capped by the role of the user who minted it —
 * the same clamping rule agents follow.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId('key'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First 8 chars of the key, for display: `fgb_a1b2c3d4…`. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    role: text('role').$type<import('./identity').Role>().notNull().default('member'),
    /** Narrow a key further than its role, e.g. read-only for a dashboard. */
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('api_keys_token_hash_key').on(t.tokenHash),
    index('api_keys_ws_idx').on(t.workspaceId, t.revokedAt),
  ],
);

/* ── Product usage & support signals ─────────────────────────────────────── */

/**
 * Product usage, rolled up per account per day.
 *
 * Daily buckets rather than raw events: the CRM's questions are "is this
 * account's usage falling?" and "who are the power users?", and storing every
 * pageview to answer those would trade a great deal of storage for no extra
 * signal. A product-analytics warehouse remains the system of record for
 * event-level data; this is the shape the CRM actually reasons over.
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    id: primaryId('usg'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Calendar day in UTC. */
    day: timestamp('day', { withTimezone: true, mode: 'date' }).notNull(),
    activeUsers: integer('active_users').notNull().default(0),
    sessions: integer('sessions').notNull().default(0),
    events: integer('events').notNull().default(0),
    /** Usage of the features that correlate with retention. */
    keyActions: integer('key_actions').notNull().default(0),
    /** Provider the rollup came from, e.g. posthog / amplitude / manual. */
    source: text('source').notNull().default('manual'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('usage_daily_key').on(t.workspaceId, t.accountId, t.contactId, t.day),
    index('usage_daily_ws_account_day_idx').on(t.workspaceId, t.accountId, t.day),
  ],
);

export const SUPPORT_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/**
 * Support tickets, ingested as another raw interaction source.
 *
 * A ticket is a customer telling you something is wrong, which is exactly the
 * kind of signal a relationship model should carry — so tickets run through
 * the same extraction pipeline as email and produce the same timeline events,
 * objections and product signals.
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: primaryId('tkt'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    provider: text('provider'),
    subject: text('subject').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').$type<SupportStatus>().notNull().default('open'),
    priority: text('priority').$type<'low' | 'normal' | 'high' | 'urgent'>().notNull().default('normal'),
    /** Customer satisfaction, where the provider captured it. */
    satisfaction: real('satisfaction'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    firstResponseMinutes: integer('first_response_minutes'),
    sentiment: real('sentiment'),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    searchVector: tsvector('search_vector'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('support_tickets_ws_account_idx').on(t.workspaceId, t.accountId, t.openedAt),
    index('support_tickets_ws_status_idx').on(t.workspaceId, t.status),
    index('support_tickets_ws_unprocessed_idx').on(t.workspaceId, t.processedAt),
  ],
);

/* ── Website analytics ────────────────────────────────────────────────────── */

/**
 * One row per page view on the public marketing site.
 *
 * No IP address is stored. A visitor is a hash of (daily salt, IP, user
 * agent): the same person counts once per day, and once the day's salt is
 * deleted the hash cannot be reversed — even by us. That is the approach of
 * privacy-first analytics tools, and it means no cookie banner is needed.
 * The trade-off: a person visiting on three days counts three times across
 * the period, which the analytics view says plainly.
 */
export const siteVisits = pgTable(
  'site_visits',
  {
    id: primaryId('vis'),
    /** UTC day, YYYY-MM-DD. */
    day: text('day').notNull(),
    visitorHash: text('visitor_hash').notNull(),
    path: text('path').notNull(),
    /** Hostname only — never the full referring URL, which can carry personal data. */
    referrerHost: text('referrer_host'),
    /** ISO country code from the edge network, when available. */
    country: text('country'),
    device: text('device').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('site_visits_day_idx').on(t.day),
    index('site_visits_day_visitor_idx').on(t.day, t.visitorHash),
  ],
);

/**
 * The random salt for each day's visitor hashes. Old salts are deleted, which
 * is what makes yesterday's hashes impossible to link back to anyone.
 */
export const siteSalts = pgTable('site_salts', {
  day: text('day').primaryKey(),
  salt: text('salt').notNull(),
});
