import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { listReports, runReportById } from '@/server/analytics/ask';
import { listInsights } from '@/server/intelligence/insights';
import { getPipelineSummary } from '@/server/crm/opportunities';
import { PageShell } from '@/components/layout/app-shell';
import {
  Card,
  CardBody,
  EmptyState,
  PageHeader,
  SectionLabel,
  Stat,
} from '@/components/ui/primitives';
import { AnalyticsResultView } from '@/components/ai/analytics-view';
import { InsightCard } from '@/components/ai/answer';
import { AskInline } from '@/components/ai/ask-inline';
import { RecomputeInsights } from './recompute';
import { NavIcon, Sparkle } from '@/components/layout/icons';
import { moneyShort, number } from '@/lib/utils';

export const metadata = { title: 'Analytics' };

/**
 * Ask-your-business analytics.
 *
 * Every number here comes from a pre-approved report template, and each ships
 * with its methodology. There is deliberately no free-SQL surface: a question
 * that no template answers returns "no template matched" rather than letting a
 * model improvise a query against production data.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const reportId = params.report ?? 'pipeline_by_stage';

  const [reports, insights, summary, active] = await Promise.all([
    listReports(),
    listInsights(ctx, 8),
    getPipelineSummary(ctx),
    runReportById(ctx, reportId),
  ]);

  return (
    <PageShell wide>
      <PageHeader
        title="Analytics"
        description="Ask in English, or pick a report. Every answer states how it was calculated and links to the records behind it."
        actions={<RecomputeInsights />}
      />

      <div className="mt-5">
        <AskInline
          placeholder="Ask about your business — pipeline, conversion, objections, product demand…"
          suggestions={reports.slice(0, 4).map((r) => r.example)}
        />
      </div>

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Open pipeline" value={moneyShort(summary.openValue)} hint={`${summary.openCount} deals`} />
          <Stat label="Weighted" value={moneyShort(summary.weightedValue)} />
          <Stat
            label="At risk"
            value={moneyShort(summary.atRiskValue)}
            tone={summary.atRiskValue > 0 ? 'danger' : 'neutral'}
          />
          <Stat label="Closing in 30d" value={moneyShort(summary.closingThirtyDays)} />
          <Stat
            label="Won this quarter"
            value={moneyShort(summary.wonValueThisQuarter)}
            hint={`${summary.wonThisQuarter} deals`}
            tone="success"
          />
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* ── Report rail ───────────────────────────────────────────────── */}
        <nav aria-label="Reports" className="min-w-0">
          <SectionLabel>Reports</SectionLabel>
          <ul className="mt-2 space-y-0.5">
            {reports.map((report) => (
              <li key={report.id}>
                <Link
                  href={`/analytics?report=${report.id}`}
                  aria-current={report.id === reportId ? 'page' : undefined}
                  className={
                    report.id === reportId
                      ? 'block rounded-[var(--radius-md)] bg-surface px-2 py-1.5 text-xs font-medium text-text shadow-[var(--shadow-sm)]'
                      : 'block rounded-[var(--radius-md)] px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-muted hover:text-text'
                  }
                >
                  {report.label}
                </Link>
              </li>
            ))}
          </ul>

          <p className="mt-3 px-1 text-[10px] leading-relaxed text-text-subtle text-pretty">
            Reports are parameterised, read-only templates. No model-generated SQL reaches the
            database.
          </p>
        </nav>

        {/* ── Active report + insights ──────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          {active ? (
            <AnalyticsResultView result={active} />
          ) : (
            <EmptyState
              icon={<NavIcon name="chart" />}
              title="No such report"
              description="Pick one from the list, or ask a question above."
            />
          )}

          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <SectionLabel>Patterns Figbolt has found</SectionLabel>
              <span className="text-2xs text-text-subtle">{number(insights.length)} insights</span>
            </div>

            {insights.length === 0 ? (
              <EmptyState
                icon={<Sparkle />}
                title="No cross-account patterns yet"
                description="Patterns need enough closed deals and recorded conversations to compare. Detectors that lack a large enough cohort report nothing rather than a hedged guess."
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
      </div>
    </PageShell>
  );
}
