import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx } from '@/server/context';
import { getRun } from '@/server/agents/runtime';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
  SectionLabel,
  Stat,
  StatusDot,
} from '@/components/ui/primitives';
import { CitationList } from '@/components/ai/citation';
import { StepList } from './step-list';
import { AlertTriangle, Shield } from '@/components/layout/icons';
import { number, relativeTime, shortDate, timeOfDay, titleCase } from '@/lib/utils';

export const metadata = { title: 'Agent run' };

/**
 * Run inspection.
 *
 * Every plan, model call, tool call, argument, result and approval was
 * persisted as it happened, so this page shows what the agent actually did —
 * not a reconstruction. That is what makes "review its evidence, then approve"
 * a real workflow rather than an act of faith.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  const ctx = await requireCtx();

  const detail = await getRun(ctx, runId);
  if (!detail || detail.run.agentId !== id) notFound();

  const { run, steps, agent } = detail;
  const toolCalls = steps.filter((s) => s.kind === 'tool_call');
  const modelCalls = steps.filter((s) => s.kind === 'model_call');
  const errors = steps.filter((s) => s.status === 'error');
  const awaiting = steps.filter((s) => s.status === 'awaiting_approval');

  return (
    <PageShell>
      <div className="min-w-0">
        <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
          <Link href="/agents" className="hover:text-text">
            Agents
          </Link>
          <span>/</span>
          <Link href={`/agents/${id}`} className="hover:text-text">
            {agent?.name ?? 'Agent'}
          </Link>
          <span>/</span>
          <span className="text-text-muted">Run</span>
        </nav>

        <div className="flex flex-wrap items-center gap-2.5">
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
          <h1 className="text-xl font-semibold tracking-tight text-text">
            {titleCase(run.status.replace('_', ' '))}
          </h1>
          <Badge tone="outline">{run.triggerKind}</Badge>
          <span className="font-mono text-2xs text-text-subtle">{run.id}</span>
        </div>

        <p className="mt-1.5 text-xs text-text-muted">
          {run.startedAt ? `${shortDate(run.startedAt)} at ${timeOfDay(run.startedAt)}` : 'Not started'}
          {run.triggerDetail && ` · ${run.triggerDetail}`}
        </p>
      </div>

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Steps" value={number(steps.length)} />
          <Stat label="Tool calls" value={number(toolCalls.length)} />
          <Stat label="Model calls" value={number(modelCalls.length)} />
          <Stat label="Latency" value={run.latencyMs ? `${run.latencyMs}ms` : '—'} />
          <Stat
            label="Tokens"
            value={number(run.promptTokens + run.completionTokens)}
            hint={`${number(run.promptTokens)} in · ${number(run.completionTokens)} out`}
          />
          <Stat
            label="Errors"
            value={number(errors.length)}
            tone={errors.length > 0 ? 'danger' : 'neutral'}
          />
        </CardBody>
      </Card>

      {run.summary && (
        <Card className="mt-5">
          <CardHeader>
            <div>
              <CardTitle>What the agent reported</CardTitle>
              <p className="mt-0.5 text-2xs text-text-subtle">
                Its own summary. Private reasoning is never stored — only the trace below.
              </p>
            </div>
          </CardHeader>
          <CardBody className="pt-0">
            <p className="text-sm leading-relaxed text-text text-pretty">{run.summary}</p>

            {Array.isArray(run.output?.['findings']) && (
              <ul className="mt-3 space-y-1.5">
                {(run.output['findings'] as unknown[]).map((finding, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed text-text-muted text-pretty">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                    <span>{String(finding)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {run.error && (
        <Card className="mt-5 border-danger/30">
          <CardBody className="flex gap-2.5 pt-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-danger-text">The run failed</p>
              <p className="mt-1 font-mono text-2xs break-words text-danger-text/85">{run.error}</p>
            </div>
          </CardBody>
        </Card>
      )}

      {awaiting.length > 0 && (
        <Card className="mt-5 border-warning/30">
          <CardBody className="flex gap-2.5 pt-4">
            <Shield className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-warning-text">
                {awaiting.length} action{awaiting.length === 1 ? '' : 's'} were not performed
              </p>
              <p className="mt-1 text-2xs leading-relaxed text-warning-text/85 text-pretty">
                They are queued for your approval. Review them in the Inbox or on the agent page —
                nothing runs until you decide.
              </p>
              <Link
                href="/inbox?section=agent_approval"
                className="mt-1.5 inline-block text-2xs font-medium text-warning-text hover:underline"
              >
                Review pending approvals
              </Link>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <SectionLabel>Execution trace</SectionLabel>
          <div className="mt-3">
            <StepList
              steps={steps.map((step) => ({
                id: step.id,
                index: step.index,
                kind: step.kind,
                title: step.title,
                tool: step.tool,
                input: step.input,
                output: step.output,
                status: step.status,
                error: step.error,
                riskLevel: step.riskLevel,
                sources: step.sources,
                latencyMs: step.latencyMs,
                promptTokens: step.promptTokens,
                completionTokens: step.completionTokens,
              }))}
            />
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Run details</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <dl>
                <DetailRow label="Agent">
                  <Link href={`/agents/${id}`} className="text-accent-text hover:underline">
                    {agent?.name ?? '—'}
                  </Link>
                </DetailRow>
                <DetailRow label="Trigger">{run.triggerKind}</DetailRow>
                <DetailRow label="Model">{run.model ?? '—'}</DetailRow>
                <DetailRow label="Started">
                  {run.startedAt ? relativeTime(run.startedAt) : '—'}
                </DetailRow>
                <DetailRow label="Finished">
                  {run.finishedAt ? relativeTime(run.finishedAt) : 'still running'}
                </DetailRow>
              </dl>
            </CardBody>
          </Card>

          {run.sources.length > 0 && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Records it read</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    Everything the agent used to reach its conclusion
                  </p>
                </div>
              </CardHeader>
              <CardBody className="pt-0">
                <CitationList sources={run.sources} numbered={false} label="Sources" />
              </CardBody>
            </Card>
          )}

          {run.input && Object.keys(run.input).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Trigger payload</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <pre className="max-h-56 overflow-auto rounded-[var(--radius-md)] bg-bg-subtle px-3 py-2 font-mono text-[10px] leading-relaxed text-text-muted">
                  {JSON.stringify(run.input, null, 2)}
                </pre>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </PageShell>
  );
}
