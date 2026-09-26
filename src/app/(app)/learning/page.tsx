import { requireCtx } from '@/server/context';
import { caseCounts, currentFailures, recentRuns } from '@/server/learning/evaluate';
import { calibration, recentSignals, signalSummary } from '@/server/learning/signals';
import { openProposals, proposalCounts } from '@/server/learning/propose';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  ProgressBar,
  SectionLabel,
  Stat,
} from '@/components/ui/primitives';
import { NavIcon } from '@/components/layout/icons';
import { relativeTime, titleCase } from '@/lib/utils';
import { LoopControls, ProposalCard } from './controls';

export const metadata = { title: 'Learning' };

/**
 * The learning loop, made visible.
 *
 * The honest framing matters on this page: the pass rate is a *delta* signal,
 * not an accuracy claim. The corpus is grown from the cases humans corrected,
 * so it is biased toward the hard ones by construction — 85% here does not
 * mean 85% in production. What it means is that if this number falls after a
 * change, the change broke something a person had already confirmed.
 */
export default async function LearningPage() {
  const ctx = await requireCtx();

  const [runs, cases, signals, failures, proposals, counts, calib, latestSignals] =
    await Promise.all([
      recentRuns(ctx, 12),
      caseCounts(ctx),
      signalSummary(ctx),
      currentFailures(ctx, 12),
      openProposals(ctx, 10),
      proposalCounts(ctx),
      calibration(ctx),
      recentSignals(ctx, 8),
    ]);

  const latest = runs[0] ?? null;
  const previous = runs[1] ?? null;
  const rate = latest && latest.totalCases > 0 ? latest.passed / latest.totalCases : null;
  const prevRate =
    previous && previous.totalCases > 0 ? previous.passed / previous.totalCases : null;
  const delta = rate != null && prevRate != null ? rate - prevRate : null;

  const totalCases = cases.reduce((n, c) => n + c.n, 0);
  const fromUsage = cases.filter((c) => c.origin === 'usage').reduce((n, c) => n + c.n, 0);
  const totalSignals = signals.reduce((n, s) => n + s.n, 0);
  const corrections = signals.filter((s) => s.verdict === 'corrected').reduce((n, s) => n + s.n, 0);

  const byTask = latest?.scoreByTask ?? {};

  return (
    <PageShell wide>
      <PageHeader
        title="Learning"
        description="Every judgement someone makes about the engine's output becomes a case it is scored against. Failures cluster into proposals a human approves — nothing changes the engine on its own."
        actions={<LoopControls hasCases={totalCases > 0} />}
      />

      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-5">
          <Stat
            label="Pass rate"
            value={rate == null ? '—' : `${Math.round(rate * 100)}%`}
            hint={
              latest
                ? `${latest.passed}/${latest.totalCases} · ${relativeTime(latest.startedAt)}`
                : 'never run'
            }
            tone={rate == null ? 'neutral' : rate >= 0.85 ? 'success' : rate >= 0.7 ? 'neutral' : 'warning'}
          />
          <Stat
            label="Since last run"
            value={
              delta == null ? '—' : `${delta > 0 ? '+' : ''}${Math.round(delta * 100)}pt`
            }
            hint={delta == null ? 'need two runs' : delta < 0 ? 'regression' : 'holding'}
            tone={delta == null ? 'neutral' : delta < -0.02 ? 'danger' : 'neutral'}
          />
          <Stat label="Cases" value={String(totalCases)} hint={`${fromUsage} from real usage`} />
          <Stat
            label="Signals captured"
            value={String(totalSignals)}
            hint={`${corrections} carry a correction`}
          />
          <Stat
            label="Open proposals"
            value={String(counts['proposed'] ?? 0)}
            hint={`${counts['approved'] ?? 0} approved · ${counts['rejected'] ?? 0} rejected`}
            tone={(counts['proposed'] ?? 0) > 0 ? 'warning' : 'neutral'}
          />
        </CardBody>
      </Card>

      {totalCases === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="sparkles" />}
          title="The corpus is empty"
          description="Cases come from real judgements: approve an agent's proposal and it becomes a case asserting the engine keeps producing it; reject one and it becomes a case asserting the engine stops. Run the loop to seed the regression cases the test suite already pins."
        />
      ) : (
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          {/* ── Left: proposals, then failures ─────────────────────────── */}
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Proposals awaiting a human</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    The loop names a file and describes the change. It never edits anything.
                  </p>
                </div>
                {proposals.length > 0 && <Badge tone="warning">{proposals.length} open</Badge>}
              </CardHeader>
              <CardBody className="pt-0">
                {proposals.length === 0 ? (
                  <p className="text-xs text-text-subtle">
                    No open proposals. A change is only proposed when at least two cases fail the
                    same way — one failure is noise, not a pattern.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {proposals.map((p) => (
                      <ProposalCard
                        key={p.id}
                        proposal={{
                          id: p.id,
                          task: p.task,
                          title: p.title,
                          rationale: p.rationale,
                          target: p.target,
                          change: p.change,
                          failingCases: p.failingCaseIds.length,
                          createdAt: p.createdAt,
                        }}
                      />
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Failing cases</CardTitle>
                {failures.length > 0 && <Badge tone="danger">{failures.length}</Badge>}
              </CardHeader>
              <CardBody className="pt-0">
                {failures.length === 0 ? (
                  <p className="text-xs text-text-subtle">
                    Everything in the corpus passes against the current engine.
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {failures.map((f) => (
                      <li key={f.caseId} className="min-w-0 border-b border-border pb-2.5 last:border-0">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <Badge tone="neutral" size="sm">
                            {f.task.replace(/^extract_/, '')}
                          </Badge>
                          <span className="min-w-0 text-xs font-medium text-text">{f.label}</span>
                          {f.origin === 'usage' && (
                            <Badge tone="info" size="sm">
                              from usage
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 font-mono text-2xs text-danger-text">{f.detail}</p>
                        <p className="mt-1 truncate text-2xs text-text-subtle">
                          “{f.inputText.replace(/\s+/g, ' ').slice(0, 110)}”
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          {/* ── Right: corpus, trend, calibration ──────────────────────── */}
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <CardTitle>By capability</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                {Object.keys(byTask).length === 0 ? (
                  <p className="text-xs text-text-subtle">Run the loop to score each capability.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {Object.entries(byTask)
                      .sort(([, a], [, b]) => a.passed / a.total - b.passed / b.total)
                      .map(([task, s]) => (
                        <li key={task} className="min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate text-xs text-text-muted">
                              {task.replace(/^extract_/, '').replace(/_/g, ' ')}
                            </span>
                            <span className="shrink-0 text-2xs tabular text-text-subtle">
                              {s.passed}/{s.total}
                            </span>
                          </div>
                          <ProgressBar
                            className="mt-1"
                            value={s.passed}
                            max={s.total}
                            label={`${s.passed} of ${s.total} passing`}
                          />
                        </li>
                      ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Is confidence meaningful?</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    If rejected output scores as confidently as accepted output, the number is
                    decoration.
                  </p>
                </div>
              </CardHeader>
              <CardBody className="pt-0">
                {calib.length === 0 ? (
                  <p className="text-xs text-text-subtle">
                    Not enough judged output with a recorded confidence yet.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {calib.map((c) => (
                      <li
                        key={`${c.task}-${c.verdict}`}
                        className="flex items-baseline justify-between gap-2 text-xs"
                      >
                        <span className="min-w-0 truncate text-text-muted">
                          {c.task.replace(/^extract_/, '')} ·{' '}
                          <span
                            className={
                              c.verdict === 'negative' ? 'text-danger-text' : 'text-success-text'
                            }
                          >
                            {c.verdict}
                          </span>
                        </span>
                        <span className="shrink-0 tabular text-text">
                          {c.avgConfidence.toFixed(2)}{' '}
                          <span className="text-text-subtle">({c.n})</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent judgements</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                {latestSignals.length === 0 ? (
                  <p className="text-xs text-text-subtle">
                    Nothing captured yet. Approving, rejecting or editing an agent proposal records
                    one automatically.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {latestSignals.map((s) => (
                      <li key={s.id} className="flex items-baseline gap-2 text-2xs">
                        <Badge
                          tone={
                            s.verdict === 'positive'
                              ? 'success'
                              : s.verdict === 'negative'
                                ? 'danger'
                                : 'info'
                          }
                          size="sm"
                        >
                          {s.verdict}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-text-muted">
                          {s.task.replace(/^extract_/, '').replace(/_/g, ' ')}
                          {s.note ? ` — ${s.note}` : ''}
                        </span>
                        <span className="shrink-0 text-text-subtle">
                          {relativeTime(s.occurredAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {runs.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle>Run history</CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                  <ul className="space-y-1">
                    {runs.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-baseline justify-between gap-2 text-2xs"
                      >
                        <span className="text-text-muted">
                          {titleCase(r.trigger)} · {relativeTime(r.startedAt)}
                        </span>
                        <span className="tabular text-text">
                          {r.totalCases > 0
                            ? `${Math.round((r.passed / r.totalCases) * 100)}%`
                            : '—'}{' '}
                          <span className="text-text-subtle">
                            ({r.passed}/{r.totalCases})
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            )}
          </div>
        </div>
      )}

      <Card className="mt-6 border-accent-border bg-accent-subtle">
        <CardBody className="pt-4">
          <SectionLabel>What this number is and is not</SectionLabel>
          <p className="mt-1.5 text-2xs leading-relaxed text-accent-text/85 text-pretty">
            The corpus is built from the cases a human had to correct, so it over-represents the
            hard ones. Read the pass rate as a regression detector, not an accuracy claim: it
            falling after a change is the signal. Proposals name a file and describe a change in
            words — the loop has no path that edits source, prompts or rules, because an extraction
            rule that widened itself overnight could flood every account with false concerns and
            the only symptom would be people trusting the product less.
          </p>
        </CardBody>
      </Card>
    </PageShell>
  );
}
