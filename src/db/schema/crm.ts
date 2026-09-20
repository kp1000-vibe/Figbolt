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
} from 'drizzle-orm/pg-core';
import { money, primaryId, softDelete, timestamps } from './_shared';
import { users, workspaces } from './identity';

export const accounts = pgTable(
  'accounts',
  {
    id: primaryId('acc'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain'),
    website: text('website'),
    industry: text('industry'),
    employeeCount: integer('employee_count'),
    annualRevenue: money('annual_revenue'),
    /** Committed recurring revenue today (customers), distinct from pipeline. */
    currentArr: money('current_arr'),
    location: text('location'),
    country: text('country'),
    description: text('description'),
    tier: text('tier').$type<'enterprise' | 'mid_market' | 'smb'>(),
    lifecycleStage: text('lifecycle_stage')
      .$type<'prospect' | 'opportunity' | 'customer' | 'churned'>()
      .notNull()
      .default('prospect'),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** 0-100, recomputed by the memory engine; never a bare number in the UI. */
    healthScore: integer('health_score'),
    healthRationale: jsonb('health_rationale').$type<HealthRationale>(),
    sentiment: real('sentiment'),
    engagementTrend: text('engagement_trend').$type<'rising' | 'steady' | 'declining'>(),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true, mode: 'date' }),
    /** Level-3 memory: the rolling AI relationship summary. */
    memorySummary: jsonb('memory_summary').$type<AccountMemorySummary>(),
    memoryUpdatedAt: timestamp('memory_updated_at', { withTimezone: true, mode: 'date' }),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('accounts_ws_idx').on(t.workspaceId, t.deletedAt),
    index('accounts_ws_owner_idx').on(t.workspaceId, t.ownerId),
    index('accounts_ws_domain_idx').on(t.workspaceId, t.domain),
    index('accounts_ws_last_interaction_idx').on(t.workspaceId, t.lastInteractionAt),
  ],
);

export type SourceRef = {
  type:
    | 'email'
    | 'meeting'
    | 'transcript'
    | 'note'
    | 'call'
    | 'task'
    | 'commitment'
    | 'crm_event'
    | 'memory_fact'
    | 'knowledge'
    | 'opportunity'
    | 'account'
    | 'contact';
  id: string;
  label: string;
  occurredAt?: string;
  snippet?: string;
};

export type EvidenceBullet = {
  label: string;
  detail?: string;
  weight: number;
  sources?: SourceRef[];
};

export type HealthRationale = {
  score: number;
  positives: EvidenceBullet[];
  risks: EvidenceBullet[];
  computedAt: string;
  method: string;
};

export type RecommendedAction = {
  title: string;
  why: string;
  /** Machine-actionable hint the UI turns into a button. */
  action?: {
    kind: 'draft_email' | 'create_task' | 'open_record' | 'schedule_meeting' | 'update_stage';
    payload?: Record<string, unknown>;
  };
};

export type AccountMemorySummary = {
  relationship: string;
  currentPriorities: string[];
  customerGoals: string[];
  recentChanges: string[];
  knownRisks: string[];
  opportunities: string[];
  openCommitments: string[];
  recommendedActions: RecommendedAction[];
  sources: SourceRef[];
};

export const BUYING_ROLES = [
  'champion',
  'decision_maker',
  'economic_buyer',
  'technical_evaluator',
  'blocker',
  'influencer',
  'end_user',
  'unknown',
] as const;
export type BuyingRole = (typeof BUYING_ROLES)[number];

export type ContactMemorySummary = {
  summary: string;
  priorities: string[];
  concerns: string[];
  communicationStyle?: string;
  sources: SourceRef[];
};

export const contacts = pgTable(
  'contacts',
  {
    id: primaryId('con'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    title: text('title'),
    seniority: text('seniority').$type<'c_level' | 'vp' | 'director' | 'manager' | 'ic'>(),
    department: text('department'),
    linkedinUrl: text('linkedin_url'),
    location: text('location'),
    timezone: text('timezone'),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** Buying-committee role, inferred by the memory engine but user-editable. */
    buyingRole: text('buying_role').$type<BuyingRole>(),
    influence: integer('influence'),
    sentiment: real('sentiment'),
    relationshipStrength: integer('relationship_strength'),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true, mode: 'date' }),
    memorySummary: jsonb('memory_summary').$type<ContactMemorySummary>(),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('contacts_ws_idx').on(t.workspaceId, t.deletedAt),
    index('contacts_ws_account_idx').on(t.workspaceId, t.accountId),
    index('contacts_ws_email_idx').on(t.workspaceId, t.email),
  ],
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: primaryId('pipe'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
    position: integer('position').notNull().default(0),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('pipelines_ws_idx').on(t.workspaceId)],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: primaryId('stg'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    /** Default win probability for deals resting in this stage. */
    probability: integer('probability').notNull().default(0),
    type: text('type').$type<'open' | 'won' | 'lost'>().notNull().default('open'),
    /** What must be true to legitimately sit here - used by AI stage checks. */
    entryCriteria: text('entry_criteria'),
    color: text('color'),
    ...timestamps,
  },
  (t) => [index('pipeline_stages_pipeline_idx').on(t.pipelineId, t.position)],
);

export type OpportunityMemorySummary = {
  summary: string;
  whyBuying: string;
  keyStakeholders: { contactId: string; name: string; role: BuyingRole; note?: string }[];
  competitors: string[];
  objections: string[];
  risks: EvidenceBullet[];
  recentChanges: string[];
  nextBestActions: RecommendedAction[];
  missingInformation: string[];
  sources: SourceRef[];
};

export const opportunities = pgTable(
  'opportunities',
  {
    id: primaryId('opp'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: text('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    value: money('value').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    probability: integer('probability'),
    status: text('status').$type<'open' | 'won' | 'lost'>().notNull().default('open'),
    lossReason: text('loss_reason'),
    expectedCloseDate: timestamp('expected_close_date', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source'),
    /** 0-100 with mandatory rationale - see `HealthRationale`. */
    healthScore: integer('health_score'),
    healthRationale: jsonb('health_rationale').$type<HealthRationale>(),
    memorySummary: jsonb('memory_summary').$type<OpportunityMemorySummary>(),
    memoryUpdatedAt: timestamp('memory_updated_at', { withTimezone: true, mode: 'date' }),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true, mode: 'date' }),
    stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Fractional rank so Kanban drag-and-drop never rewrites the column. */
    position: real('position').notNull().default(0),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('opportunities_ws_idx').on(t.workspaceId, t.deletedAt),
    index('opportunities_ws_stage_idx').on(t.workspaceId, t.stageId, t.position),
    index('opportunities_ws_account_idx').on(t.workspaceId, t.accountId),
    index('opportunities_ws_owner_idx').on(t.workspaceId, t.ownerId),
    index('opportunities_ws_status_close_idx').on(t.workspaceId, t.status, t.expectedCloseDate),
  ],
);

export const RELATIONSHIP_TYPES = [
  'works_at',
  'reports_to',
  'champion_for',
  'decision_maker_for',
  'economic_buyer_for',
  'technical_evaluator_for',
  'blocker_for',
  'belongs_to',
  'relates_to',
  'originated_from',
  'requested_by',
  'primary_contact',
  'knows',
  'introduced_by',
  'owns',
  'attended',
  'mentions',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Typed edges between any two records - the relationship graph.
 * `fromType`/`toType` are object kinds ('contact', 'account', 'user', ...) so
 * custom objects participate without a schema change.
 */
export const relationships = pgTable(
  'relationships',
  {
    id: primaryId('rel'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromType: text('from_type').notNull(),
    fromId: text('from_id').notNull(),
    type: text('type').$type<RelationshipType>().notNull(),
    toType: text('to_type').notNull(),
    toId: text('to_id').notNull(),
    strength: integer('strength'),
    confidence: real('confidence').notNull().default(1),
    source: text('source')
      .$type<'manual' | 'derived' | 'import' | 'integration'>()
      .notNull()
      .default('manual'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('relationships_ws_from_idx').on(t.workspaceId, t.fromType, t.fromId),
    index('relationships_ws_to_idx').on(t.workspaceId, t.toType, t.toId),
    uniqueIndex('relationships_edge_key').on(
      t.workspaceId,
      t.fromType,
      t.fromId,
      t.type,
      t.toType,
      t.toId,
    ),
  ],
);
