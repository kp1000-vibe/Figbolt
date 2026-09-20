import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, requireCtx } from '@/server/context';
import { describeTrigger, getAgent, toolCatalogue } from '@/server/agents/manage';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
  EmptyState,
  SectionLabel,
  Stat,
  StatusDot,
} from '@/components/ui/primitives';
import { ApprovalCard } from '@/components/ai/approval-card';
import { AgentRowActions } from '../row-actions';
import { AgentEditLink } from './edit-link';
import { NavIcon, Shield } from '@/components/layout/icons';
import { cn, number, relativeTime, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { agent } = await getAgent(ctx, id);
    return { title: agent.name };
  } catch {
    return { title: 'Agent' };
  }
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getAgent>>;
  try {
    detail = await getAgent(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { agent, runs, pendingApprovals } = detail;
  const tools = await toolCatalogue();
  const enabledTools = tools.filter((t) => agent.toolNames.includes(t.name));

  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const avgLatency =
    runs.filter((r) => r.latencyMs).reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) /
    Math.max(runs.filter((r) => r.latencyMs).length, 1);
  const totalTokens = runs.reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0);

  return (
    <PageShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
            <Link href="/agents" className="hover:text-text">
              Agents
            </Link>
          </nav>

          <div className="flex flex-wrap items-center gap-2.5">
            <StatusDot
              tone={agent.enabled ? 'success' : 'neutral'}
              label={agent.enabled ? 'Enabled' : 'Paused'}
            />
            <h1 className="text-xl font-semibold tracking-tight text-text">{agent.name}</h1>
            {!agent.enabled && <Badge tone="neutral">Paused</Badge>}
          </div>

          {agent.description && (
            <p className="mt-1.5 max-w-2xl text-sm text-text-muted text-pretty">
              {agent.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <AgentEditLink agentId={agent.id} />
          <AgentRowActions agentId={agent.id} enabled={agent.enabled} />
        </div>
      </div>

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Runs" value={number(runs.length)} hint={`${succeeded} succeeded`} />
          <Stat
            label="Failures"
            value={number(failed)}
            tone={failed > 0 ? 'danger' : 'neutral'}
          />
          <Stat
            label="Avg latency"
            value={avgLatency > 0 ? `${Math.round(avgLatency)}ms` : '—'}
          />
          <Stat label="Tokens" value={number(totalTokens)} hint="Prompt + completion" />
          <Stat
            label="Awaiting approval"
            value={number(pendingApprovals.length)}
            tone={pendingApprovals.length > 0 ? 'warning' : 'neutral'}
          />
        </CardBody>
      </Card>

      {pendingApprovals.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 flex items-center gap-2">
            <SectionLabel>Proposed actions awaiting you</SectionLabel>
            <Badge tone="warning">{pendingApprovals.length}</Badge>
          </div>
          <div className="space-y-3">
            {pendingApprovals.map((approval) => (
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

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Run history</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {runs.length === 0 ? (
                <p className="text-xs text-text-subtle">
                  No runs yet. Use &ldquo;Run now&rdquo; to try it — nothing consequential will happen
                  without your approval.
                </p>
              ) : (
                <ul className="space-y-2">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/agents/${agent.id}/runs/${run.id}`}
                        className="group block rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2.5 transition-colors hover:border-border-strong"
                      >
                        <div className="flex flex-wrap items-center gap-2">
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
                          <span className="text-xs font-medium text-text group-hover:text-accent-text">
                            {titleCase(run.status.replace('_', ' '))}
                          </span>
                          <Badge tone="outline">{run.triggerKind}</Badge>
                          <span className="ml-auto text-2xs text-text-subtle">
                            {relativeTime(run.finishedAt ?? run.createdAt)}
                          </span>
                        </div>

                        {run.summary && (
                          <p className="mt-1.5 line-clamp-2 text-2xs leading-relaxed text-text-muted text-pretty">
                            {run.summary}
                          </p>
                        )}

                        <p className="mt-1 font-mono text-[10px] text-text-subtle">
                          {run.stepCount} steps
                          {run.latencyMs ? ` · ${run.latencyMs}ms` : ''}
                          {run.promptTokens + run.completionTokens > 0
                            ? ` · ${number(run.promptTokens + run.completionTokens)} tokens`
                            : ''}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Plan</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {agent.steps.length === 0 ? (
                <p className="text-xs text-text-subtle">No explicit plan configured.</p>
              ) : (
                <ol className="space-y-2">
                  {agent.steps.map((step, i) => (
                    <li
                      key={step.id}
                      className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-border bg-bg-subtle px-2.5 py-2"
                    >
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-surface text-[10px] font-bold text-text-muted">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-1.5">
                          <p className="text-xs font-medium text-text">{step.title}</p>
                          <Badge tone="outline">{step.kind}</Badge>
                          {step.tool && (
                            <span className="font-mono text-[10px] text-text-subtle">{step.tool}</span>
                          )}
                        </div>
                        {step.detail && (
                          <p className="mt-0.5 text-2xs leading-relaxed text-text-muted text-pretty">
                            {step.detail}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Operating instructions</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <pre className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] bg-bg-subtle px-3 py-2.5 font-sans text-2xs leading-relaxed whitespace-pre-wrap text-text-muted">
                {agent.instructions}
              </pre>
            </CardBody>
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <dl>
                <DetailRow label="Trigger">{describeTrigger(agent.trigger)}</DetailRow>
                {agent.nextRunAt && agent.enabled && (
                  <DetailRow label="Next run">{relativeTime(agent.nextRunAt)}</DetailRow>
                )}
                <DetailRow label="Last run">
                  {agent.lastRunAt ? relativeTime(agent.lastRunAt) : 'never'}
                </DetailRow>
                <DetailRow label="Max role">{titleCase(agent.maxRole)}</DetailRow>
                <DetailRow label="Tools enabled">{agent.toolNames.length}</DetailRow>
              </dl>

              {Object.keys(agent.filters ?? {}).length > 0 && (
                <>
                  <SectionLabel className="mt-4">Filters</SectionLabel>
                  <dl className="mt-1">
                    {Object.entries(agent.filters ?? {}).map(([key, value]) => (
                      <DetailRow key={key} label={key}>
                        {String(value)}
                      </DetailRow>
                    ))}
                  </dl>
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start gap-2">
                <Shield className="mt-0.5 size-4 shrink-0 text-accent" />
                <div>
                  <CardTitle>Permissions</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    What this agent may do unattended
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardBody className="pt-0">
              <div className="space-y-1.5">
                {(['low', 'medium', 'high'] as const).map((level) => {
                  const auto = agent.approvalPolicy.autoApprove.includes(level);
                  return (
                    <div
                      key={level}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-[var(--radius-md)] border px-2.5 py-1.5',
                        auto ? 'border-success/30 bg-success-subtle' : 'border-border bg-bg-subtle',
                      )}
                    >
                      <span className="text-xs text-text">{titleCase(level)} risk</span>
                      <Badge tone={auto ? 'success' : 'neutral'}>
                        {auto ? 'Runs automatically' : 'Needs approval'}
                      </Badge>
                    </div>
                  );
                })}
              </div>

              <p className="mt-3 text-2xs leading-relaxed text-text-subtle text-pretty">
                Permissions are re-resolved on every run against the live role of the user this agent
                runs as. Removing that person from the workspace stops the agent immediately.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tools</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {enabledTools.length === 0 ? (
                <p className="text-xs text-text-subtle">No tools enabled.</p>
              ) : (
                <ul className="space-y-2">
                  {enabledTools.map((tool) => (
                    <li key={tool.name} className="flex items-start gap-2">
                      <span
                        className={cn(
                          'mt-1 size-1.5 shrink-0 rounded-full',
                          tool.readOnly
                            ? 'bg-success'
                            : tool.risk === 'high'
                              ? 'bg-danger'
                              : 'bg-warning',
                        )}
                      />
                      <div className="min-w-0">
                        <p className="font-mono text-2xs text-text">{tool.name}</p>
                        <p className="text-[10px] leading-snug text-text-subtle">
                          {tool.readOnly ? 'Read-only' : `${titleCase(tool.risk)} risk`} ·{' '}
                          {tool.permission}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Original request</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <p className="text-xs leading-relaxed text-text-muted italic text-pretty">
                &ldquo;{agent.prompt}&rdquo;
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
