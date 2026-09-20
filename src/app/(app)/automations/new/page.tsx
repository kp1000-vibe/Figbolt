import { ctxAssert, requireCtx } from '@/server/context';
import { listAgents } from '@/server/agents/manage';
import { PageShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/primitives';
import { AutomationBuilder } from './builder';

export const metadata = { title: 'New automation' };

export default async function NewAutomationPage() {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'automation:manage');

  const agents = await listAgents(ctx);

  return (
    <PageShell>
      <PageHeader
        title="New automation"
        description="Pick a trigger, add conditions, then choose what happens. Anything that changes data still goes through the approval model."
      />

      <div className="mt-6">
        <AutomationBuilder agents={agents.map((a) => ({ id: a.id, name: a.name }))} />
      </div>
    </PageShell>
  );
}
