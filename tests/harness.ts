import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import {
  accounts,
  agents,
  opportunities,
  pipelines,
  pipelineStages,
  users,
  workspaceMembers,
  workspaces,
  type Role,
} from '@/db/schema';
import type { Ctx } from '@/server/context';

/**
 * A real database for tests.
 *
 * PGlite in a throwaway directory, migrated with the production migration
 * runner. Authorization tests against a mocked database would prove nothing —
 * the whole point is that the same SQL, the same `scope()` predicates and the
 * same dispatcher run here as in production.
 */

export type Harness = {
  db: Database;
  workspaceId: string;
  otherWorkspaceId: string;
  ctxFor: (role: Role) => Ctx;
  /** A context in the *other* tenant, for cross-workspace isolation tests. */
  otherCtx: Ctx;
  accountId: string;
  otherAccountId: string;
  opportunityId: string;
  /** A real agent row, so approvals created in tests satisfy the foreign key. */
  agentId: string;
  cleanup: () => Promise<void>;
};

export async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-test-'));

  // Reset the module-level handle so each harness gets its own database.
  const globalRef = globalThis as unknown as { __nexusDb?: unknown };
  globalRef.__nexusDb = undefined;

  const { runMigrations } = await import('@/db/migrate');
  await runMigrations({ log: false, dataDir: dir });

  const { getHandle } = await import('@/db/client');
  const handle = await getHandle(dir);
  const db = handle.db;

  const [owner] = await db
    .insert(users)
    .values({ email: `owner-${Date.now()}@example.test`, name: 'Test Owner' })
    .returning({ id: users.id });

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: 'Test Workspace', slug: `test-${Date.now()}` })
    .returning({ id: workspaces.id });

  const [other] = await db
    .insert(workspaces)
    .values({ name: 'Other Tenant', slug: `other-${Date.now()}` })
    .returning({ id: workspaces.id });

  await db.insert(workspaceMembers).values({
    workspaceId: workspace!.id,
    userId: owner!.id,
    role: 'owner',
    status: 'active',
  });

  const [pipeline] = await db
    .insert(pipelines)
    .values({ workspaceId: workspace!.id, name: 'Sales', isDefault: true })
    .returning({ id: pipelines.id });

  const [stage] = await db
    .insert(pipelineStages)
    .values({
      workspaceId: workspace!.id,
      pipelineId: pipeline!.id,
      name: 'Discovery',
      position: 0,
      probability: 20,
    })
    .returning({ id: pipelineStages.id });

  const [account] = await db
    .insert(accounts)
    .values({ workspaceId: workspace!.id, name: 'Acme Test', domain: 'acme.test' })
    .returning({ id: accounts.id });

  const [otherAccount] = await db
    .insert(accounts)
    .values({ workspaceId: other!.id, name: 'Foreign Account', domain: 'foreign.test' })
    .returning({ id: accounts.id });

  const [opportunity] = await db
    .insert(opportunities)
    .values({
      workspaceId: workspace!.id,
      accountId: account!.id,
      pipelineId: pipeline!.id,
      stageId: stage!.id,
      name: 'Acme — Initial',
      value: 50_000,
      status: 'open',
    })
    .returning({ id: opportunities.id });

  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: workspace!.id,
      name: 'Test Agent',
      prompt: 'A test agent.',
      instructions: 'Do nothing surprising.',
      trigger: { kind: 'manual' },
      // Deliberately the most permissive policy an agent could claim, so tests
      // can prove the dispatcher still refuses to auto-run high risk.
      approvalPolicy: { autoApprove: ['low', 'medium', 'high'], notify: 'owner', expiresAfterHours: 48 },
      runAsUserId: owner!.id,
      maxRole: 'member',
    })
    .returning({ id: agents.id });

  const ctxFor = (role: Role): Ctx => ({
    db,
    workspaceId: workspace!.id,
    userId: owner!.id,
    role,
    actor: { type: 'user', id: owner!.id, label: 'Test Owner' },
  });

  return {
    db,
    workspaceId: workspace!.id,
    otherWorkspaceId: other!.id,
    ctxFor,
    otherCtx: {
      db,
      workspaceId: other!.id,
      userId: null,
      role: 'owner',
      actor: { type: 'system', id: 'test', label: 'Other tenant' },
    },
    accountId: account!.id,
    otherAccountId: otherAccount!.id,
    opportunityId: opportunity!.id,
    agentId: agent!.id,
    async cleanup() {
      await db.delete(workspaces).where(eq(workspaces.id, workspace!.id));
      await handle.close();
      globalRef.__nexusDb = undefined;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
