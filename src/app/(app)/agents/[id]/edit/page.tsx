import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, requireCtx, ctxAssert } from '@/server/context';
import { getAgent, toolCatalogue } from '@/server/agents/manage';
import { getDb } from '@/db/client';
import { users, workspaceMembers } from '@/db/schema';
import { PageShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/primitives';
import { AgentBuilder } from '../../new/builder';

export const metadata = { title: 'Edit agent' };

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  ctxAssert(ctx, 'agent:manage');

  let detail: Awaited<ReturnType<typeof getAgent>>;
  try {
    detail = await getAgent(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

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

  const { agent } = detail;

  return (
    <PageShell>
      <PageHeader
        title={`Edit ${agent.name}`}
        description="Change the description and recompile, or edit the configuration directly."
      />

      <div className="mt-6">
        <AgentBuilder
          tools={tools}
          team={team}
          defaultRunAsUserId={ctx.session.user.id}
          existing={{
            id: agent.id,
            prompt: agent.prompt,
            enabled: agent.enabled,
            runAsUserId: agent.runAsUserId,
            compiled: {
              name: agent.name,
              description: agent.description ?? '',
              instructions: agent.instructions,
              trigger: agent.trigger,
              toolNames: agent.toolNames,
              steps: agent.steps,
              filters: agent.filters ?? {},
              outputSchema: agent.outputSchema,
              approvalPolicy: agent.approvalPolicy,
              confidence: 1,
            },
          }}
        />
      </div>
    </PageShell>
  );
}
