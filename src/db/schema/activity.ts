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
import { primaryId, softDelete, timestamps, tsvector } from './_shared';
import { users, workspaces } from './identity';
import type { SourceRef } from './crm';
import { accounts, contacts, opportunities } from './crm';

/**
 * LEVEL 1 - RAW SOURCES.
 *
 * Nothing in this file is ever mutated by the AI. Extraction writes *derived*
 * rows elsewhere that point back here, so every high-level claim in the
 * product can be walked down to a verbatim source.
 */

export const emailThreads = pgTable(
  'email_threads',
  {
    id: primaryId('thr'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Provider-native thread id, used for idempotent re-sync. */
    externalId: text('external_id'),
    provider: text('provider'),
    subject: text('subject').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    participantEmails: jsonb('participant_emails').$type<string[]>().notNull().default([]),
    messageCount: integer('message_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('email_threads_ws_idx').on(t.workspaceId, t.lastMessageAt),
    index('email_threads_ws_account_idx').on(t.workspaceId, t.accountId),
    index('email_threads_ws_external_idx').on(t.workspaceId, t.provider, t.externalId),
  ],
);

export const emails = pgTable(
  'emails',
  {
    id: primaryId('eml'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => emailThreads.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    provider: text('provider'),
    /** RFC-5322 Message-ID / In-Reply-To, preserved so threading survives sync. */
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    direction: text('direction').$type<'inbound' | 'outbound'>().notNull(),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name'),
    toEmails: jsonb('to_emails').$type<string[]>().notNull().default([]),
    ccEmails: jsonb('cc_emails').$type<string[]>().notNull().default([]),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull().default(''),
    bodySnippet: text('body_snippet'),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    sentiment: real('sentiment'),
    /** Set once the memory engine has extracted facts from this message. */
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    /** Generated column: to_tsvector(subject || body). See migration 0001. */
    searchVector: tsvector('search_vector'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('emails_ws_sent_idx').on(t.workspaceId, t.sentAt),
    index('emails_ws_account_idx').on(t.workspaceId, t.accountId, t.sentAt),
    index('emails_ws_opp_idx').on(t.workspaceId, t.opportunityId),
    index('emails_ws_contact_idx').on(t.workspaceId, t.contactId),
    index('emails_ws_thread_idx').on(t.workspaceId, t.threadId),
    index('emails_ws_unprocessed_idx').on(t.workspaceId, t.processedAt),
  ],
);

export const meetings = pgTable(
  'meetings',
  {
    id: primaryId('mtg'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    provider: text('provider'),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    location: text('location'),
    meetingUrl: text('meeting_url'),
    recordingUrl: text('recording_url'),
    status: text('status')
      .$type<'scheduled' | 'completed' | 'cancelled' | 'no_show'>()
      .notNull()
      .default('scheduled'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    organizerId: text('organizer_id').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalised roster; authoritative membership lives in meeting_participants. */
    participantEmails: jsonb('participant_emails').$type<string[]>().notNull().default([]),
    /** LEVEL 2 output for this meeting - see `MeetingIntelligence`. */
    intelligence: jsonb('intelligence').$type<MeetingIntelligence>(),
    sentiment: real('sentiment'),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    searchVector: tsvector('search_vector'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('meetings_ws_start_idx').on(t.workspaceId, t.startsAt),
    index('meetings_ws_account_idx').on(t.workspaceId, t.accountId, t.startsAt),
    index('meetings_ws_opp_idx').on(t.workspaceId, t.opportunityId),
    index('meetings_ws_unprocessed_idx').on(t.workspaceId, t.processedAt),
  ],
);

export type MeetingIntelligence = {
  summary: string;
  keyDecisions: string[];
  customerPains: string[];
  questions: string[];
  objections: string[];
  competitorsMentioned: string[];
  pricingDiscussion: string | null;
  productRequests: string[];
  nextSteps: string[];
  sentimentLabel: 'positive' | 'neutral' | 'mixed' | 'negative';
  sentimentReason: string;
  followUpDraft: { subject: string; body: string } | null;
  sources: SourceRef[];
  confidence: number;
  generatedAt: string;
};

export const meetingParticipants = pgTable(
  'meeting_participants',
  {
    id: primaryId('mpt'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    name: text('name'),
    isOrganizer: boolean('is_organizer').notNull().default(false),
    attended: boolean('attended').notNull().default(true),
    /** Share of transcript lines spoken - a cheap engagement proxy. */
    talkRatio: real('talk_ratio'),
    ...timestamps,
  },
  (t) => [
    index('meeting_participants_meeting_idx').on(t.meetingId),
    index('meeting_participants_ws_contact_idx').on(t.workspaceId, t.contactId),
  ],
);

export const transcripts = pgTable(
  'transcripts',
  {
    id: primaryId('trn'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'cascade' }),
    callId: text('call_id'),
    source: text('source').notNull().default('upload'),
    language: text('language').notNull().default('en'),
    /** Verbatim, immutable. The single ground truth for meeting claims. */
    segments: jsonb('segments').$type<TranscriptSegment[]>().notNull().default([]),
    fullText: text('full_text').notNull().default(''),
    durationSeconds: integer('duration_seconds'),
    searchVector: tsvector('search_vector'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('transcripts_ws_meeting_idx').on(t.workspaceId, t.meetingId),
  ],
);

export type TranscriptSegment = {
  /** Stable within a transcript so citations can deep-link to a line. */
  index: number;
  speaker: string;
  speakerEmail?: string;
  isCustomer: boolean;
  startSeconds: number;
  text: string;
};

export const calls = pgTable(
  'calls',
  {
    id: primaryId('call'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    provider: text('provider'),
    direction: text('direction').$type<'inbound' | 'outbound'>().notNull(),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    durationSeconds: integer('duration_seconds'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    outcome: text('outcome'),
    recordingUrl: text('recording_url'),
    notes: text('notes'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('calls_ws_occurred_idx').on(t.workspaceId, t.occurredAt)],
);

export const notes = pgTable(
  'notes',
  {
    id: primaryId('note'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    /** Polymorphic anchor: 'account' | 'contact' | 'opportunity' | 'meeting'. */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    pinned: boolean('pinned').notNull().default(false),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    searchVector: tsvector('search_vector'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('notes_ws_subject_idx').on(t.workspaceId, t.subjectType, t.subjectId),
    index('notes_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
);

export const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = pgTable(
  'tasks',
  {
    id: primaryId('task'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').$type<TaskStatus>().notNull().default('open'),
    priority: text('priority').$type<'low' | 'normal' | 'high' | 'urgent'>()
      .notNull()
      .default('normal'),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    /** Set when an agent (not a human) created the task. */
    createdByAgentId: text('created_by_agent_id'),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('tasks_ws_status_due_idx').on(t.workspaceId, t.status, t.dueAt),
    index('tasks_ws_assignee_idx').on(t.workspaceId, t.assigneeId, t.status),
    index('tasks_ws_opp_idx').on(t.workspaceId, t.opportunityId),
    index('tasks_ws_account_idx').on(t.workspaceId, t.accountId),
  ],
);

export const COMMITMENT_STATUSES = [
  'open',
  'fulfilled',
  'overdue',
  'cancelled',
  'unconfirmed',
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/**
 * A promise someone made, extracted from a conversation.
 * `direction` distinguishes "we owe them" from "they owe us" - the two drive
 * completely different follow-up behaviour.
 */
export const commitments = pgTable(
  'commitments',
  {
    id: primaryId('cmt'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    direction: text('direction').$type<'we_owe' | 'they_owe'>().notNull(),
    /** Free-text owner name as spoken, resolved to ids where possible. */
    ownerLabel: text('owner_label').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    ownerContactId: text('owner_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    counterpartyLabel: text('counterparty_label'),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    status: text('status').$type<CommitmentStatus>().notNull().default('open'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true, mode: 'date' }),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    /** Evidence pointer - the transcript segment or email this came from. */
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceQuote: text('source_quote'),
    sourceSegmentIndex: integer('source_segment_index'),
    confidence: real('confidence').notNull().default(0.5),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('commitments_ws_status_due_idx').on(t.workspaceId, t.status, t.dueAt),
    index('commitments_ws_account_idx').on(t.workspaceId, t.accountId),
    index('commitments_ws_opp_idx').on(t.workspaceId, t.opportunityId),
  ],
);

/**
 * Generic activity feed row. Every interaction lands here as well as in its
 * typed table, so "recent activity" is one indexed query rather than a union.
 */
export const activities = pgTable(
  'activities',
  {
    id: primaryId('act'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<'email' | 'meeting' | 'call' | 'note' | 'task' | 'stage_change' | 'field_change'>()
      .notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    summary: text('summary'),
    direction: text('direction').$type<'inbound' | 'outbound' | 'internal'>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    ...timestamps,
  },
  (t) => [
    index('activities_ws_occurred_idx').on(t.workspaceId, t.occurredAt),
    index('activities_ws_account_idx').on(t.workspaceId, t.accountId, t.occurredAt),
    index('activities_ws_opp_idx').on(t.workspaceId, t.opportunityId, t.occurredAt),
    index('activities_ws_contact_idx').on(t.workspaceId, t.contactId, t.occurredAt),
  ],
);

export const CRM_EVENT_TYPES = [
  'email_sent',
  'email_received',
  'meeting_scheduled',
  'meeting_happened',
  'call_logged',
  'stage_changed',
  'stakeholder_discovered',
  'objection_identified',
  'commitment_made',
  'commitment_fulfilled',
  'task_completed',
  'pricing_discussed',
  'competitor_mentioned',
  'sentiment_changed',
  'contract_sent',
  'renewal_discussed',
  'feature_requested',
  'field_updated',
  'record_created',
  'risk_detected',
  'note_added',
] as const;
export type CrmEventType = (typeof CRM_EVENT_TYPES)[number];

/**
 * The narrative timeline. Distinct from `activities`: an activity is "an email
 * happened"; a crm_event is "something changed about this relationship".
 */
export const crmEvents = pgTable(
  'crm_events',
  {
    id: primaryId('evt'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<CrmEventType>().notNull(),
    subjectType: text('subject_type').$type<'account' | 'contact' | 'opportunity'>().notNull(),
    subjectId: text('subject_id').notNull(),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    actorType: text('actor_type')
      .$type<'user' | 'agent' | 'system' | 'integration' | 'contact'>()
      .notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    title: text('title').notNull(),
    body: text('body'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** 1-5; drives timeline density filtering and briefing selection. */
    importance: integer('importance').notNull().default(2),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    ...timestamps,
  },
  (t) => [
    index('crm_events_ws_subject_idx').on(
      t.workspaceId,
      t.subjectType,
      t.subjectId,
      t.occurredAt,
    ),
    index('crm_events_ws_occurred_idx').on(t.workspaceId, t.occurredAt),
    index('crm_events_ws_type_idx').on(t.workspaceId, t.type, t.occurredAt),
    index('crm_events_ws_account_idx').on(t.workspaceId, t.accountId, t.occurredAt),
  ],
);
