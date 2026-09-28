import { requireCtx, ctxAssert } from '@/server/context';
import { toolCatalogue } from '@/server/agents/manage';
import { getDb } from '@/db/client';
import { users, workspaceMembers } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { PageShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/primitives';
import { AgentBuilder } from './builder';

export const metadata = { title: 'New agent' };

export default async function NewAgentPage() {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'agent:manage');

  const db = await getDb();
  const [tools, team] = await Promise.all([
    toolCatalogue(),
    db
      .select({ id: users.id, name: users.name, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.status, 'active')),
      )
      .orderBy(users.name),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="New agent"
        description="Describe the task in plain English. Bolt compiles it into a trigger, filters, a tool set and a plan — all of which you can edit before saving."
      />

      <div className="mt-6">
        <AgentBuilder
          tools={tools}
          team={team}
          defaultRunAsUserId={ctx.session.user.id}
        />
      </div>
    </PageShell>
  );
}
