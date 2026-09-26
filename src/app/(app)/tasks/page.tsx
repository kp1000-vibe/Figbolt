import { requireCtx } from '@/server/context';
import { listCommitments, listTasks, taskCounts } from '@/server/crm/tasks';
import { PageShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/primitives';
import { TasksView } from './tasks-view';

export const metadata = { title: 'Tasks' };

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; bucket?: string; q?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [tasks, counts, weOwe, theyOwe] = await Promise.all([
    listTasks(ctx, { bucket: params.bucket, query: params.q, limit: 200 }),
    taskCounts(ctx, ctx.session.user.id),
    listCommitments(ctx, { direction: 'we_owe', bucket: 'open', limit: 100 }),
    listCommitments(ctx, { direction: 'they_owe', bucket: 'open', limit: 100 }),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Tasks &amp; commitments"
        description="Tasks you or an agent created, alongside the promises Figbolt extracted from conversations."
      />

      <div className="mt-5">
        <TasksView
          tasks={tasks.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            dueAt: t.dueAt?.toISOString() ?? null,
            assigneeName: t.assigneeName,
            accountId: t.accountId,
            accountName: t.accountName,
            opportunityId: t.opportunityId,
            opportunityName: t.opportunityName,
            createdByAgentId: t.createdByAgentId,
            sourceType: t.sourceType,
          }))}
          weOwe={serialiseCommitments(weOwe)}
          theyOwe={serialiseCommitments(theyOwe)}
          counts={counts}
          initialTab={params.tab}
          currentBucket={params.bucket}
        />
      </div>
    </PageShell>
  );
}

function serialiseCommitments(rows: Awaited<ReturnType<typeof listCommitments>>) {
  return rows.map((c) => ({
    id: c.id,
    description: c.description,
    direction: c.direction,
    ownerLabel: c.ownerLabel,
    dueAt: c.dueAt,
    status: c.status,
    confidence: c.confidence,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    sourceQuote: c.sourceQuote,
    taskId: c.taskId,
    accountId: c.accountId,
    accountName: c.accountName,
    opportunityId: c.opportunityId,
  }));
}
