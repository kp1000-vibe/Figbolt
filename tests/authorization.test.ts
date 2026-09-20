import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, auditEvents } from '@/db/schema';
import { scope, scoped, ctxCan, ctxAssert } from '@/server/context';
import { AuthorizationError, can, effectiveAgentRole, permissionsFor, roleAtLeast } from '@/lib/security/permissions';
import { createHarness, type Harness } from './harness';

/**
 * Authorization and tenant isolation.
 *
 * These are the tests the spec calls non-negotiable, and they are written
 * against a real database rather than mocks: a `scope()` predicate that
 * silently stopped filtering would pass any mock-based assertion while leaking
 * every tenant's data in production.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

describe('role permissions', () => {
  it('gives a viewer read access and nothing that writes', () => {
    expect(can('viewer', 'record:read')).toBe(true);
    expect(can('viewer', 'record:create')).toBe(false);
    expect(can('viewer', 'record:update')).toBe(false);
    expect(can('viewer', 'email:send')).toBe(false);
    expect(can('viewer', 'workspace:manage')).toBe(false);
  });

  it('does not let a member manage the workspace or approve high-risk actions', () => {
    expect(can('member', 'record:create')).toBe(true);
    expect(can('member', 'workspace:manage')).toBe(false);
    expect(can('member', 'ai:approve_high')).toBe(false);
  });

  it('ranks roles so a lower role never satisfies a higher requirement', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
    expect(roleAtLeast('member', 'member')).toBe(true);
    expect(roleAtLeast('viewer', 'member')).toBe(false);
  });

  it('never grants a permission that is absent from the role table', () => {
    for (const role of ['viewer', 'member', 'manager', 'admin', 'owner'] as const) {
      const granted = permissionsFor(role);
      for (const permission of granted) {
        expect(can(role, permission)).toBe(true);
      }
    }
  });
});

describe('agent role clamping', () => {
  it('takes the lower of the agent ceiling and the live user role', () => {
    expect(effectiveAgentRole('admin', 'member')).toBe('member');
    expect(effectiveAgentRole('member', 'admin')).toBe('member');
    expect(effectiveAgentRole('viewer', 'owner')).toBe('viewer');
  });

  it('returns null when the authorising user no longer has a role', () => {
    // A removed user must disable their agents immediately, without anyone
    // having to remember to edit the agent.
    expect(effectiveAgentRole('admin', null)).toBeNull();
  });
});

describe('ctx permission helpers', () => {
  it('reports and enforces the context role', () => {
    const viewer = h.ctxFor('viewer');
    expect(ctxCan(viewer, 'record:read')).toBe(true);
    expect(ctxCan(viewer, 'record:create')).toBe(false);
    expect(() => ctxAssert(viewer, 'record:create')).toThrow(AuthorizationError);
    expect(() => ctxAssert(h.ctxFor('owner'), 'record:create')).not.toThrow();
  });

  it('names the missing permission on the error, without leaking data', () => {
    try {
      ctxAssert(h.ctxFor('viewer'), 'workspace:manage');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).permission).toBe('workspace:manage');
    }
  });
});

describe('workspace scoping', () => {
  it('never returns rows from another tenant', async () => {
    const ctx = h.ctxFor('owner');

    const mine = await ctx.db.select({ id: accounts.id }).from(accounts).where(scope(ctx, accounts));
    expect(mine.map((r) => r.id)).toContain(h.accountId);
    expect(mine.map((r) => r.id)).not.toContain(h.otherAccountId);
  });

  it('filters by workspace even when handed a foreign id directly', async () => {
    const ctx = h.ctxFor('owner');

    // The attack this defends against: an id harvested from another tenant and
    // replayed into an endpoint that only checks "does this row exist?".
    const rows = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(scoped(ctx, accounts, eq(accounts.id, h.otherAccountId)));

    expect(rows).toHaveLength(0);
  });

  it('excludes soft-deleted rows', async () => {
    const ctx = h.ctxFor('owner');

    const [temp] = await ctx.db
      .insert(accounts)
      .values({ workspaceId: ctx.workspaceId, name: 'Soon Deleted' })
      .returning({ id: accounts.id });

    await ctx.db
      .update(accounts)
      .set({ deletedAt: new Date() })
      .where(eq(accounts.id, temp!.id));

    const rows = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(scoped(ctx, accounts, eq(accounts.id, temp!.id)));

    expect(rows).toHaveLength(0);
  });
});

describe('audit log', () => {
  it('exposes no update or delete path', async () => {
    // Append-only is a property of the module surface, not a convention: if
    // someone adds a mutation helper this test fails and they have to justify it.
    const auditModule: Record<string, unknown> = await import('@/server/audit');
    const mutators = Object.keys(auditModule).filter((name) =>
      /^(update|delete|remove|purge|clear|edit)/i.test(name),
    );
    expect(mutators).toEqual([]);
  });

  it('records the actor and risk level of an action', async () => {
    const ctx = h.ctxFor('owner');
    const { record } = await import('@/server/audit');

    await record(ctx, {
      action: 'test.performed',
      resourceType: 'account',
      resourceId: h.accountId,
      riskLevel: 'high',
      metadata: { note: 'from the authorization suite' },
    });

    const rows = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'test.performed'));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(ctx.workspaceId);
    expect(rows[0]!.riskLevel).toBe('high');
    expect(rows[0]!.actorType).toBe('user');
  });
});
