import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_shared';

/** Global identity. A user may belong to many workspaces. */
export const users = pgTable(
  'users',
  {
    id: primaryId('usr'),
    email: text('email').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    title: text('title'),
    /** scrypt: `scrypt$N$r$p$salt$hash`. Never a plaintext or reversible value. */
    passwordHash: text('password_hash'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: primaryId('ws'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    domain: text('domain'),
    logoUrl: text('logo_url'),
    /** Answers from onboarding — becomes org-level agent context. */
    companyContext: jsonb('company_context').$type<CompanyContext>(),
    onboardingStep: text('onboarding_step').notNull().default('workspace'),
    onboardingCompletedAt: timestamp('onboarding_completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    isDemo: boolean('is_demo').notNull().default(false),
    /** Workspace-wide AI guardrails; see `src/lib/agents/policy.ts`. */
    aiSettings: jsonb('ai_settings').$type<WorkspaceAiSettings>(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('workspaces_slug_key').on(t.slug)],
);

export type CompanyContext = {
  whatWeSell?: string;
  idealCustomer?: string;
  targetIndustries?: string[];
  qualificationCriteria?: string;
  salesProcess?: string;
  commonObjections?: string[];
  competitors?: string[];
  differentiators?: string;
};

export type WorkspaceAiSettings = {
  /** Action classes an agent may take with no human in the loop. */
  autoApprove?: { low: boolean; medium: boolean; high: boolean };
  /** Agents explicitly permitted to send external email unattended. */
  autonomousEmailAgentIds?: string[];
  /** Hard ceiling on tool calls in a single agent run. */
  maxStepsPerRun?: number;
  /** Redact contact email addresses before they reach a hosted model. */
  redactPiiInPrompts?: boolean;
};

export const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: primaryId('wsm'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull().default('member'),
    status: text('status').$type<'active' | 'invited' | 'suspended'>().notNull().default('active'),
    invitedById: text('invited_by_id'),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('workspace_members_ws_user_key').on(t.workspaceId, t.userId),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: primaryId('team'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (t) => [index('teams_ws_idx').on(t.workspaceId)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    id: primaryId('tm'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('team_members_team_user_key').on(t.teamId, t.userId)],
);

/** Server-side session records so sessions can be revoked before JWT expiry. */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId('sess'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token; the raw token only ever lives in the cookie. */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);
