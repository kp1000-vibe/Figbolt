import {
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
import { money, primaryId, softDelete, timestamps, tsvector } from './_shared';
import { users, workspaces } from './identity';
import { accounts, contacts, opportunities } from './crm';
import type { SourceRef } from './crm';

/** Embedding width. Must match `EMBEDDING_DIMENSIONS`; changing it needs a migration. */
export const EMBEDDING_DIM = 768;

export const FACT_STATUSES = ['active', 'superseded', 'retracted', 'disputed'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/**
 * LEVEL 2 - STRUCTURED FACTS, stored bitemporally.
 *
 * Facts are *never* updated in place. A new observation inserts a new row that
 * points at its predecessor via `supersedesId` and stamps the predecessor's
 * `validUntil`. That preserves both questions the product must answer:
 *
 *   "What is Acme's budget?"            -> status='active'
 *   "How has Acme's budget changed?"    -> full chain ordered by validFrom
 */
export const memoryFacts = pgTable(
  'memory_facts',
  {
    id: primaryId('fact'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').$type<'account' | 'contact' | 'opportunity'>().notNull(),
    subjectId: text('subject_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    /** Stable machine key, e.g. `budget`, `timeline`, `competitor`, `security_requirement`. */
    key: text('key').notNull(),
    /** Human label for the UI, e.g. "Expected budget". */
    label: text('label').notNull(),
    valueText: text('value_text'),
    valueNumber: money('value_number'),
    valueJson: jsonb('value_json').$type<unknown>(),
    unit: text('unit'),
    confidence: real('confidence').notNull().default(0.5),
    source: text('source')
      .$type<'derived' | 'manual' | 'import' | 'integration'>()
      .notNull()
      .default('derived'),
    /** Evidence pointer into the raw-source layer. */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    sourceQuote: text('source_quote'),
    extractedByRunId: text('extracted_by_run_id'),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').$type<FactStatus>().notNull().default('active'),
    /** When the fact became true in the world (not when we learned it). */
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }),
    supersedesId: text('supersedes_id'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('memory_facts_ws_subject_idx').on(
      t.workspaceId,
      t.subjectType,
      t.subjectId,
      t.status,
    ),
    index('memory_facts_ws_key_idx').on(t.workspaceId, t.key, t.status),
    index('memory_facts_ws_account_idx').on(t.workspaceId, t.accountId),
    index('memory_facts_chain_idx').on(t.supersedesId),
    index('memory_facts_ws_valid_idx').on(t.workspaceId, t.validFrom),
  ],
);

/**
 * Hybrid-search index over every embeddable artefact.
 *
 * One table rather than per-type columns: retrieval ranks emails, transcript
 * chunks, notes and knowledge side by side, and `ownerType` filters afterwards.
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: primaryId('emb'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    chunkIndex: integer('chunk_index').notNull().default(0),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    /** Denormalised scope so retrieval can filter without joins. */
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    model: text('model').notNull(),
    searchVector: tsvector('search_vector'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('embeddings_owner_chunk_key').on(t.workspaceId, t.ownerType, t.ownerId, t.chunkIndex),
    index('embeddings_ws_owner_type_idx').on(t.workspaceId, t.ownerType),
    index('embeddings_ws_account_idx').on(t.workspaceId, t.accountId),
    index('embeddings_ws_occurred_idx').on(t.workspaceId, t.occurredAt),
  ],
);

export const SIGNAL_CATEGORIES = [
  'feature_request',
  'bug',
  'integration_request',
  'security_requirement',
  'pricing_concern',
  'competitor',
  'workflow_pain',
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

/**
 * Canonical product themes ("SSO", "Salesforce integration"). Individual
 * mentions attach to a theme so the dashboard can aggregate pipeline dollars.
 */
export const productSignalThemes = pgTable(
  'product_signal_themes',
  {
    id: primaryId('theme'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').$type<SignalCategory>().notNull(),
    description: text('description'),
    /** Normalised match key used to dedupe incoming mentions. */
    slug: text('slug').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    status: text('status')
      .$type<'open' | 'planned' | 'in_progress' | 'shipped' | 'declined'>()
      .notNull()
      .default('open'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('product_signal_themes_slug_key').on(t.workspaceId, t.slug)],
);

export const productSignals = pgTable(
  'product_signals',
  {
    id: primaryId('sig'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    themeId: text('theme_id').references(() => productSignalThemes.id, { onDelete: 'set null' }),
    category: text('category').$type<SignalCategory>().notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    urgency: text('urgency').$type<'low' | 'medium' | 'high' | 'blocking'>()
      .notNull()
      .default('medium'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceQuote: text('source_quote'),
    confidence: real('confidence').notNull().default(0.5),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('product_signals_ws_theme_idx').on(t.workspaceId, t.themeId),
    index('product_signals_ws_account_idx').on(t.workspaceId, t.accountId),
    index('product_signals_ws_category_idx').on(t.workspaceId, t.category, t.occurredAt),
  ],
);

export const OBJECTION_CATEGORIES = [
  'price',
  'security',
  'compliance',
  'timing',
  'competitor',
  'integration',
  'complexity',
  'authority',
  'need',
  'support',
  'other',
] as const;
export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];

export const objections = pgTable(
  'objections',
  {
    id: primaryId('obj'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    category: text('category').$type<ObjectionCategory>().notNull(),
    summary: text('summary').notNull(),
    detail: text('detail'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    severity: text('severity').$type<'low' | 'medium' | 'high'>().notNull().default('medium'),
    status: text('status')
      .$type<'open' | 'addressed' | 'resolved' | 'lost_to'>()
      .notNull()
      .default('open'),
    resolution: text('resolution'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceQuote: text('source_quote'),
    confidence: real('confidence').notNull().default(0.5),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('objections_ws_opp_idx').on(t.workspaceId, t.opportunityId),
    index('objections_ws_category_idx').on(t.workspaceId, t.category, t.occurredAt),
    index('objections_ws_account_idx').on(t.workspaceId, t.accountId),
  ],
);

/**
 * LEVEL 4 - AGGREGATED BUSINESS INTELLIGENCE.
 * Cross-account patterns surfaced on the dashboard. Each insight keeps the
 * record ids that produced it so "show me the evidence" is a real query.
 */
export const insights = pgTable(
  'insights',
  {
    id: primaryId('ins'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'pattern' | 'risk' | 'opportunity' | 'product' | 'process'>()
      .notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Quantified support, e.g. { sampleSize: 12, deltaDays: 18 }. */
    metrics: jsonb('metrics').$type<Record<string, number | string>>(),
    evidence: jsonb('evidence').$type<SourceRef[]>().notNull().default([]),
    confidence: real('confidence').notNull().default(0.5),
    severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull().default('info'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('insights_ws_kind_idx').on(t.workspaceId, t.kind, t.computedAt),
  ],
);
