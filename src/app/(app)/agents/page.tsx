import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { describeTrigger, listAgents } from '@/server/agents/manage';
import { listRuns } from '@/server/agents/runtime';
import { listPendingApprovals } from '@/server/approvals';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  SectionLabel,
  StatusDot,
} from '@/components/ui/primitives';
import { ApprovalCard } from '@/components/ai/approval-card';
import { AgentRowActions } from './row-actions';
import { NavIcon, Plus } from '@/components/layout/icons';
import { number, relativeTime } from '@/lib/utils';

export const metadata = { title: 'Agents' };

export default async function AgentsPage() {
  const ctx = await requireCtx();

  const [agents, runs, approvals] = await Promise.all([
    listAgents(ctx),
    listRuns(ctx, { limit: 15 }),
    listPendingApprovals(ctx, 25),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Agents"
        description="Agents research and propose freely. Anything that changes data or reaches a customer stops for a human."
        actions={
          <Link
            href="/agents/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] bg-accent px-3.5 text-sm font-medium text-white shadow-[var(--shadow-sm)] hover:bg-accent-hover"
          >
            <Plus className="size-4" />
            New agent
          </Link>
        }
      />

      {approvals.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2">
            <SectionLabel>Waiting on approval</SectionLabel>
            <Badge tone="warning">{approvals.length}</Badge>
          </div>
          <div className="space-y-3">
            {approvals.slice(0, 5).map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={{
                  id: approval.id,
                  tool: approval.tool,
                  riskLevel: approval.riskLevel,
                  title: approval.title,
                  rationale: approval.rationale,
                  preview: approval.preview,
                  payload: approval.payload,
                  sources: approval.sources,
                  createdAt: approval.createdAt.toISOString(),
                  expiresAt: approval.expiresAt?.toISOString() ?? null,
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <SectionLabel>Configured agents · {agents.length}</SectionLabel>

          {agents.length === 0 ? (
            <EmptyState
              className="mt-3"
              icon={<NavIcon name="bot" />}
              title="No agents yet"
              description="Describe a recurring task in plain English and Bolt will compile it into a runnable agent you can review before saving."
              action={
                <Link
                  href="/agents/new"
                  className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-surface px-3 text-xs font-medium text-text shadow-[var(--shadow-sm)] hover:bg-surface-hover"
                >
                  <Plus className="size-3.5" />
                  Create your first agent
                </Link>
              }
            />
          ) : (
            <ul className="mt-3 space-y-2.5">
              {agents.map((agent) => (
                <Card as="li" key={agent.id} className="overflow-hidden">
                  <div className="px-4 pt-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusDot
                            tone={agent.enabled ? 'success' : 'neutral'}
                            label={agent.enabled ? 'Enabled' : 'Disabled'}
                          />
                          <Link
                            href={`/agents/${agent.id}`}
                            className="min-w-0 truncate text-sm font-medium text-text hover:text-accent-text"
                          >
                            {agent.name}
                          </Link>
                          {agent.pendingApprovals > 0 && (
                            <Badge tone="warning">{agent.pendingApprovals} awaiting approval</Badge>
                          )}
                        </div>
                        {agent.description && (
                          <p className="mt-1 text-xs leading-relaxed text-text-muted text-pretty">
                            {agent.description}
                          </p>
                        )}
                      </div>

                      <AgentRowActions agentId={agent.id} enabled={agent.enabled} />
                    </div>

                    <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-text-subtle">
                      <div>
                        <dt className="inline">Trigger: </dt>
                        <dd className="inline text-text-muted">{describeTrigger(agent.trigger)}</dd>
                      </div>
                      <div>
                        <dt className="inline">Tools: </dt>
                        <dd className="inline text-text-muted">{agent.toolNames.length}</dd>
                      </div>
                      <div>
                        <dt className="inline">Runs as: </dt>
                        <dd className="inline text-text-muted">{agent.runAsName ?? 'workspace'}</dd>
                      </div>
                      <div>
                        <dt className="inline">Auto-approves: </dt>
                        <dd className="inline text-text-muted">
                          {agent.approvalPolicy.autoApprove.length > 0
                            ? agent.approvalPolicy.autoApprove.join(', ')
                            : 'nothing'}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-bg-subtle px-4 py-2 text-2xs text-text-subtle">
                    <span>{number(agent.runCount)} runs</span>
                    {agent.failureCount > 0 && (
                      <span className="text-danger-text">{agent.failureCount} failed</span>
                    )}
                    <span>Last run {agent.lastRunAt ? relativeTime(agent.lastRunAt) : 'never'}</span>
                    {agent.enabled && agent.nextRunAt && (
                      <span>Next {relativeTime(agent.nextRunAt)}</span>
                    )}
                    <Link href={`/agents/${agent.id}`} className="ml-auto text-accent-text hover:underline">
                      Open
                    </Link>
                  </div>
                </Card>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Recent runs</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {runs.length === 0 ? (
                <p className="text-xs text-text-subtle">No runs yet.</p>
              ) : (
                <ul className="space-y-2.5">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/agents/${run.agentId}/runs/${run.id}`}
                        className="group block min-w-0"
                      >
                        <div className="flex items-center gap-2">
                          <StatusDot
                            tone={
                              run.status === 'succeeded'
                                ? 'success'
                                : run.status === 'failed'
                                  ? 'danger'
                                  : run.status === 'awaiting_approval'
                                    ? 'warning'
                                    : 'accent'
                            }
                            label={run.status}
                            pulse={run.status === 'running'}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text group-hover:text-accent-text">
                            {run.agentName}
                          </span>
                          <span className="shrink-0 text-2xs text-text-subtle">
                            {relativeTime(run.finishedAt ?? run.createdAt)}
                          </span>
                        </div>
                        {run.summary && (
                          <p className="mt-0.5 line-clamp-2 pl-4 text-2xs text-text-muted text-pretty">
                            {run.summary}
                          </p>
                        )}
                        <p className="mt-0.5 pl-4 text-[10px] text-text-subtle">
                          {run.stepCount} steps
                          {run.latencyMs ? ` · ${run.latencyMs}ms` : ''} · {run.triggerKind}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card className="border-accent-border bg-accent-subtle">
            <CardBody className="pt-4">
              <p className="text-xs font-semibold text-accent-text">How the safety model works</p>
              <dl className="mt-2.5 space-y-2.5 text-2xs leading-relaxed text-accent-text/85">
                <div>
                  <dt className="font-medium">Low risk — runs automatically</dt>
                  <dd>Searching, reading, analysing, drafting internal suggestions.</dd>
                </div>
                <div>
                  <dt className="font-medium">Medium risk — configurable</dt>
                  <dd>Creating tasks, editing fields, moving stages. Held for review by default.</dd>
                </div>
                <div>
                  <dt className="font-medium">High risk — always approved by a human</dt>
                  <dd>
                    Sending email, deleting records, bulk changes. The approval screen shows the exact
                    payload, and the payload that executes is the one you read.
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-2xs text-accent-text/70 text-pretty">
                An agent&rsquo;s permissions are also clamped to the live role of the user it runs as,
                so revoking someone&rsquo;s access constrains their agents on the next run.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
