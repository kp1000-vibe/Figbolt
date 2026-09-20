import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { buildBriefing } from '@/server/ai/briefing';
import { getPipelineSummary, listOpportunities } from '@/server/crm/opportunities';
import { listInsights } from '@/server/intelligence/insights';
import { listInbox } from '@/server/inbox';
import { listRuns } from '@/server/agents/runtime';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  HealthScore,
  SectionLabel,
  Stat,
  StatusDot,
} from '@/components/ui/primitives';
import { InsightCard } from '@/components/ai/answer';
import { CitationChip } from '@/components/ai/citation';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Clock,
  NavIcon,
  Sparkle,
  TrendDown,
} from '@/components/layout/icons';
import { dayMonth, money, moneyShort, relativeTime, timeOfDay } from '@/lib/utils';
import { AskInline } from '@/components/ai/ask-inline';
import { HomeActions } from './actions-client';

export const metadata = { title: 'Home' };

export default async function HomePage() {
  const ctx = await requireCtx();

  const [briefing, pipeline, insights, inbox, runs, atRisk] = await Promise.all([
    buildBriefing(ctx, ctx.session.user.name),
    getPipelineSummary(ctx),
    listInsights(ctx, 4),
    listInbox(ctx, { limit: 6 }),
    listRuns(ctx, { limit: 5 }),
    listOpportunities(ctx, { status: 'open', flag: 'at_risk', sort: 'value', limit: 5 }),
  ]);

  return (
    <PageShell wide>
      {/* ── Briefing ──────────────────────────────────────────────────── */}
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-text">{briefing.greeting}.</h1>
        {briefing.summary.length > 0 ? (
          <p className="mt-1.5 text-sm text-text-muted text-pretty">
            You have {briefing.summary.slice(0, -1).join(', ')}
            {briefing.summary.length > 1 ? ' and ' : ''}
            {briefing.summary.at(-1)}.
          </p>
        ) : (
          <p className="mt-1.5 text-sm text-text-muted">
            Nothing needs your attention right now. Pipeline is quiet and every commitment is on track.
          </p>
        )}
      </header>

      <div className="mt-6">
        <AskInline
          placeholder="Ask anything about your customers or tell Nexus what to do…"
          suggestions={[
            'Which deals are most likely to close this month?',
            'Which customers mentioned SOC 2?',
            'What objections keep coming up in enterprise deals?',
          ]}
        />
      </div>

      {/* ── Pipeline strip ────────────────────────────────────────────── */}
      <Card className="mt-6">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Open pipeline" value={moneyShort(pipeline.openValue)} hint={`${pipeline.openCount} deals`} />
          <Stat label="Weighted" value={moneyShort(pipeline.weightedValue)} hint="By stage probability" />
          <Stat
            label="At-risk revenue"
            value={moneyShort(pipeline.atRiskValue)}
            hint="Health at or below 45"
            tone={pipeline.atRiskValue > 0 ? 'danger' : 'neutral'}
          />
          <Stat label="Closing in 30d" value={moneyShort(pipeline.closingThirtyDays)} hint="By forecast date" />
          <Stat
            label="Won this quarter"
            value={moneyShort(pipeline.wonValueThisQuarter)}
            hint={`${pipeline.wonThisQuarter} deals`}
            tone="success"
          />
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {/* ── Today's priorities ──────────────────────────────────── */}
          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <SectionLabel>Today&rsquo;s priorities</SectionLabel>
              <Link href="/inbox" className="text-2xs text-accent-text hover:underline">
                Open inbox
              </Link>
            </div>

            {briefing.priorities.length === 0 ? (
              <EmptyState
                icon={<CheckCircle />}
                title="Nothing on fire"
                description="No stalled deals, overdue commitments or passed forecast dates."
              />
            ) : (
              <ul className="space-y-2.5">
                {briefing.priorities.map((priority, i) => (
                  <Card as="li" key={`${priority.kind}-${i}`} className="overflow-hidden">
                    <div className="flex items-start gap-3 px-4 pt-3.5">
                      <span className="mt-0.5 shrink-0 text-warning">
                        {priority.kind === 'declining_engagement' ? (
                          <TrendDown className="size-4" />
                        ) : priority.kind === 'overdue_commitment' ? (
                          <Clock className="size-4" />
                        ) : (
                          <AlertTriangle className="size-4" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-sm font-medium text-text text-pretty">{priority.title}</p>
                          {priority.valueAtRisk > 0 && (
                            <Badge tone="warning">{moneyShort(priority.valueAtRisk)} at risk</Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-text-muted">{priority.detail}</p>
                        <p className="mt-1.5 text-xs leading-relaxed text-text-muted text-pretty">
                          {priority.why}
                        </p>
                        {priority.sources.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {priority.sources.map((source, j) => (
                              <CitationChip key={j} source={source} />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <HomeActions priority={priority} />
                  </Card>
                ))}
              </ul>
            )}
          </section>

          {/* ── AI insights ─────────────────────────────────────────── */}
          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <SectionLabel>What Nexus has noticed</SectionLabel>
              <Link href="/analytics" className="text-2xs text-accent-text hover:underline">
                All analytics
              </Link>
            </div>

            {insights.length === 0 ? (
              <EmptyState
                icon={<Sparkle />}
                title="No cross-account patterns yet"
                description="Patterns appear once there are enough closed deals and recorded conversations to compare."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {insights.map((insight) => (
                  <InsightCard
                    key={insight.id}
                    insight={{
                      id: insight.id,
                      kind: insight.kind,
                      title: insight.title,
                      body: insight.body,
                      metrics: insight.metrics,
                      evidence: insight.evidence,
                      confidence: insight.confidence,
                      severity: insight.severity,
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ── Right rail ────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Today&rsquo;s meetings</CardTitle>
              <Link href="/meetings" className="text-2xs text-accent-text hover:underline">
                All
              </Link>
            </CardHeader>
            <CardBody className="pt-0">
              {briefing.meetingsToday.length === 0 ? (
                <p className="text-xs text-text-subtle">No meetings scheduled today.</p>
              ) : (
                <ul className="space-y-2.5">
                  {briefing.meetingsToday.map((meeting) => (
                    <li key={meeting.id}>
                      <Link href={`/meetings/${meeting.id}`} className="group block">
                        <div className="flex items-baseline gap-2">
                          <span className="shrink-0 text-xs font-medium tabular text-text">
                            {timeOfDay(meeting.startsAt)}
                          </span>
                          <span className="min-w-0 truncate text-xs text-text-muted group-hover:text-accent-text">
                            {meeting.title}
                          </span>
                        </div>
                        {meeting.accountName && (
                          <p className="mt-0.5 pl-11 text-2xs text-text-subtle">
                            {meeting.accountName} · {meeting.participantCount} participants
                          </p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Commitments due</CardTitle>
              <Link href="/tasks?tab=commitments" className="text-2xs text-accent-text hover:underline">
                All
              </Link>
            </CardHeader>
            <CardBody className="pt-0">
              {briefing.commitmentsDue.length === 0 ? (
                <p className="text-xs text-text-subtle">Nothing due today.</p>
              ) : (
                <ul className="space-y-2.5">
                  {briefing.commitmentsDue.slice(0, 6).map((commitment) => (
                    <li key={commitment.id} className="min-w-0">
                      <div className="flex items-start gap-2">
                        <StatusDot
                          tone={commitment.overdue ? 'danger' : 'warning'}
                          label={commitment.overdue ? 'Overdue' : 'Due today'}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-text text-pretty">{commitment.description}</p>
                          <p className="mt-0.5 text-2xs text-text-subtle">
                            {commitment.accountName ?? 'Unlinked'} ·{' '}
                            {commitment.overdue ? 'overdue' : 'due'} {relativeTime(commitment.dueAt)}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>At-risk deals</CardTitle>
              <Link href="/opportunities?flag=at_risk" className="text-2xs text-accent-text hover:underline">
                All
              </Link>
            </CardHeader>
            <CardBody className="pt-0">
              {atRisk.rows.length === 0 ? (
                <p className="text-xs text-text-subtle">No open deals are scoring below 45.</p>
              ) : (
                <ul className="space-y-3">
                  {atRisk.rows.map((deal) => (
                    <li key={deal.id} className="min-w-0">
                      <Link href={`/opportunities/${deal.id}`} className="group block">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-xs font-medium text-text group-hover:text-accent-text">
                            {deal.accountName}
                          </span>
                          <span className="shrink-0 text-xs tabular text-text-muted">
                            {moneyShort(deal.value)}
                          </span>
                        </div>
                        <div className="mt-1">
                          <HealthScore score={deal.healthScore} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Agent activity</CardTitle>
              <Link href="/agents" className="text-2xs text-accent-text hover:underline">
                All
              </Link>
            </CardHeader>
            <CardBody className="pt-0">
              {runs.length === 0 ? (
                <p className="text-xs text-text-subtle">
                  No agent runs yet.{' '}
                  <Link href="/agents/new" className="text-accent-text hover:underline">
                    Create an agent
                  </Link>
                  .
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <Link href={`/agents/${run.agentId}/runs/${run.id}`} className="group block min-w-0">
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
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent customer activity</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {inbox.length === 0 ? (
                <p className="text-xs text-text-subtle">Inbox is clear.</p>
              ) : (
                <ul className="space-y-2.5">
                  {inbox.slice(0, 5).map((item) => (
                    <li key={item.id} className="min-w-0">
                      <Link href="/inbox" className="group block">
                        <p className="truncate text-xs font-medium text-text group-hover:text-accent-text">
                          {item.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-2xs text-text-muted text-pretty">
                          {item.whatHappened}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
