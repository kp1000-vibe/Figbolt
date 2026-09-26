import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '@/db/client';
import { getDb } from '@/db/client';
import type { Role } from '@/db/schema';
import { requireWorkspace, type WorkspaceContext } from '@/lib/auth/session';
import { assertCan, can, type Permission } from '@/lib/security/permissions';

export type ActorType = 'user' | 'agent' | 'system' | 'integration';

export type Actor = {
  type: ActorType;
  id: string | null;
  label: string;
};

/**
 * The request-scoped capability object.
 *
 * Nothing in `src/server` reaches for `getDb()` directly — every function takes
 * a `Ctx`. Because a `Ctx` cannot be constructed without a resolved workspace
 * and role, "which tenant is this?" and "may they do this?" are answered before
 * a query is written rather than remembered at each call site.
 *
 * An agent runs with a `Ctx` whose actor is the agent but whose `role` is the
 * effective (clamped) role of its authorizing user, so the same authorization
 * checks apply to humans and agents without a parallel code path.
 */
export type Ctx = {
  db: Database;
  workspaceId: string;
  /** The human on whose authority this is happening. Null only for system jobs. */
  userId: string | null;
  role: Role;
  actor: Actor;
  /** Set while inside an agent run so audit rows link back to the run. */
  runId?: string;
  approvalId?: string;
  request?: { ipHash?: string | null; userAgent?: string | null };
};

/** Build a Ctx for the signed-in user of the current request. */
export async function requireCtx(preferredWorkspaceId?: string): Promise<Ctx & { session: WorkspaceContext }> {
  const session = await requireWorkspace(preferredWorkspaceId);
  const db = await getDb();
  return {
    db,
    workspaceId: session.workspace.id,
    userId: session.user.id,
    role: session.role,
    actor: { type: 'user', id: session.user.id, label: session.user.name },
    session,
  };
}

/**
 * Derive an agent context from a human one. `role` must already be clamped by
 * `effectiveAgentRole` — this function will not widen it.
 */
export function agentCtx(
  base: Ctx,
  agent: { id: string; name: string },
  effectiveRole: Role,
  runId: string,
): Ctx {
  return {
    ...base,
    role: effectiveRole,
    actor: { type: 'agent', id: agent.id, label: agent.name },
    runId,
  };
}

/** Context for background work with no interactive user (schedulers, sync). */
export async function systemCtx(workspaceId: string, label = 'Figbolt system'): Promise<Ctx> {
  return {
    db: await getDb(),
    workspaceId,
    userId: null,
    role: 'admin',
    actor: { type: 'system', id: null, label },
  };
}

export function ctxCan(ctx: Ctx, permission: Permission): boolean {
  return can(ctx.role, permission);
}

export function ctxAssert(ctx: Ctx, permission: Permission): void {
  assertCan(ctx.role, permission);
}

/* ── Query scoping ────────────────────────────────────────────────────────── */

/**
 * Structural shape of a workspace-owned table. Requiring `workspaceId` here
 * means passing an unscoped table to `scope()` is a compile error, not a
 * runtime surprise — the tables that legitimately lack it (`users`,
 * `workspaces`, `rate_limits`) are queried through their own helpers.
 */
export type ScopedTable = PgTable & {
  workspaceId: PgColumn;
  deletedAt?: PgColumn;
};

/**
 * Mandatory workspace predicate.
 *
 * `scope(ctx, table)` is the only sanctioned way to start a WHERE clause on a
 * workspace-owned table. It also excludes soft-deleted rows when the table has
 * a `deleted_at` column, which keeps AI retrieval from citing records a user
 * has already removed.
 */
export function scope(
  ctx: Ctx,
  table: ScopedTable,
  options: { includeDeleted?: boolean } = {},
): SQL {
  const predicates: SQL[] = [eq(table.workspaceId, ctx.workspaceId)];
  if (table.deletedAt && !options.includeDeleted) {
    predicates.push(isNull(table.deletedAt));
  }
  return and(...predicates) as SQL;
}

/** `scope()` plus caller-supplied predicates, in one call. */
export function scoped(ctx: Ctx, table: ScopedTable, ...extra: (SQL | undefined)[]): SQL {
  const filtered = extra.filter((x): x is SQL => Boolean(x));
  return and(scope(ctx, table), ...filtered) as SQL;
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(resource: string, id?: string) {
    super(id ? `${resource} ${id} was not found.` : `${resource} was not found.`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(
    message: string,
    readonly issues?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Fetch one row by id inside the caller's workspace.
 *
 * Returning "not found" (never "forbidden") for a row in another tenant avoids
 * confirming that an id exists elsewhere.
 */
export async function findById<T extends ScopedTable & { id: PgColumn }>(
  ctx: Ctx,
  table: T,
  id: string,
  resourceName: string,
): Promise<T['$inferSelect']> {
  const rows = await ctx.db
    .select()
    // Drizzle cannot prove a generic `T extends PgTable` has a non-empty
    // selection, so the table is widened for the builder only.
    .from(table as PgTable)
    .where(and(scope(ctx, table), eq(table.id, id)))
    .limit(1);
  const row = rows[0] as T['$inferSelect'] | undefined;
  if (!row) throw new NotFoundError(resourceName, id);
  return row;
}
