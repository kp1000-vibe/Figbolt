import { sql } from 'drizzle-orm';
import type { SourceRef } from '@/db/schema';
import type { Ctx } from '../context';
import { rawQuery } from '../db-query';

/**
 * "Ask your business" — natural-language analytics.
 *
 * The security rule: **an LLM never writes SQL that reaches the database.**
 *
 * Instead there is a fixed catalogue of parameterised, read-only report
 * templates below. A question is matched to a template, its parameters are
 * validated, and Drizzle executes the template with the workspace id bound.
 * The model's only role is to help pick a template and narrate the result.
 *
 * This trades some flexibility for a guarantee: there is no code path from a
 * user's words to arbitrary SQL, so no prompt — however cleverly written —
 * can read another tenant's rows or mutate anything.
 */

export type AnalyticsChart = {
  kind: 'bar' | 'line' | 'table' | 'stat';
  title: string;
  xLabel?: string;
  yLabel?: string;
  series: { label: string; value: number; secondary?: number }[];
  valueFormat: 'currency' | 'number' | 'percent' | 'days';
};

export type AnalyticsResult = {
  reportId: string;
  answer: string;
  chart: AnalyticsChart | null;
  table: { columns: string[]; rows: (string | number)[][] } | null;
  methodology: string;
  confidence: number;
  sources: SourceRef[];
  /** Ids of the underlying records, so "show me the deals" works. */
  recordIds: { type: string; id: string; label: string }[];
};

type Report = {
  id: string;
  label: string;
  /** Question shapes that select this report. */
  patterns: RegExp[];
  run: (ctx: Ctx, params: ReportParams) => Promise<AnalyticsResult>;
};

type ReportParams = { question: string; months: number; days: number };

/* ── Report catalogue ─────────────────────────────────────────────────────── */

const REPORTS: Report[] = [
  {
    id: 'pipeline_created_by_month',
    label: 'Pipeline created by month',
    patterns: [/pipeline (?:created|generated|added)/i, /new pipeline/i, /pipeline by month/i],
    run: async (ctx, params) => {
      const rows = await rawQuery<{ bucket: string; total: number; deals: number }>(ctx, sql`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS bucket,
               COALESCE(SUM(value), 0)::float8 AS total,
               COUNT(*)::int AS deals
        FROM opportunities
        WHERE workspace_id = ${ctx.workspaceId}
          AND deleted_at IS NULL
          AND created_at >= now() - (${params.months} || ' months')::interval
        GROUP BY 1 ORDER BY 1
      `);
      const series = rows.map((r) => ({
        label: r.bucket,
        value: Number(r.total),
        secondary: Number(r.deals),
      }));
      const total = series.reduce((s, p) => s + p.value, 0);

      return {
        reportId: 'pipeline_created_by_month',
        answer:
          series.length === 0
            ? 'No opportunities were created in this window.'
            : `${money(total)} of pipeline was created across ${series.reduce((s, p) => s + (p.secondary ?? 0), 0)} opportunities in the last ${params.months} months. The strongest month was ${best(series)}.`,
        chart: {
          kind: 'bar',
          title: 'Pipeline created by month',
          xLabel: 'Month',
          yLabel: 'Value',
          series,
          valueFormat: 'currency',
        },
        table: {
          columns: ['Month', 'Pipeline value', 'Deals created'],
          rows: series.map((p) => [p.label, p.value, p.secondary ?? 0]),
        },
        methodology: `Summed opportunity value grouped by creation month over the last ${params.months} months. Soft-deleted records excluded.`,
        confidence: 0.95,
        sources: [],
        recordIds: [],
      };
    },
  },

  {
    id: 'win_rate_by_industry',
    label: 'Close rate and cycle length by industry',
    patterns: [/which industr/i, /by industry/i, /close fastest/i, /industry.*(?:win|close|convert)/i],
    run: async (ctx) => {
      const rows = await rawQuery<{
        industry: string;
        won: number;
        lost: number;
        avg_days: number;
      }>(ctx, sql`
        SELECT COALESCE(a.industry, 'Unknown') AS industry,
               COUNT(*) FILTER (WHERE o.status = 'won')::int AS won,
               COUNT(*) FILTER (WHERE o.status = 'lost')::int AS lost,
               COALESCE(AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at)) / 86400)
                        FILTER (WHERE o.status = 'won'), 0)::float8 AS avg_days
        FROM opportunities o
        JOIN accounts a ON a.id = o.account_id
        WHERE o.workspace_id = ${ctx.workspaceId}
          AND o.deleted_at IS NULL
          AND o.status IN ('won', 'lost')
        GROUP BY 1
        HAVING COUNT(*) >= 1
        ORDER BY won DESC
      `);

      const series = rows.map((r) => {
        const total = r.won + r.lost;
        return {
          label: r.industry,
          value: total > 0 ? Math.round((r.won / total) * 100) : 0,
          secondary: Math.round(Number(r.avg_days)),
        };
      });

      const fastest = [...series].filter((s) => s.secondary).sort((a, b) => (a.secondary ?? 0) - (b.secondary ?? 0))[0];
      const highest = [...series].sort((a, b) => b.value - a.value)[0];

      return {
        reportId: 'win_rate_by_industry',
        answer:
          series.length === 0
            ? 'No closed opportunities yet, so there is nothing to compare by industry.'
            : [
                highest ? `${highest.label} has the highest close rate at ${highest.value}%.` : '',
                fastest ? `${fastest.label} closes fastest, averaging ${fastest.secondary} days.` : '',
              ]
                .filter(Boolean)
                .join(' '),
        chart: {
          kind: 'bar',
          title: 'Close rate by industry',
          xLabel: 'Industry',
          yLabel: 'Close rate',
          series,
          valueFormat: 'percent',
        },
        table: {
          columns: ['Industry', 'Close rate %', 'Avg days to close'],
          rows: rows.map((r) => [
            r.industry,
            r.won + r.lost > 0 ? Math.round((r.won / (r.won + r.lost)) * 100) : 0,
            Math.round(Number(r.avg_days)),
          ]),
        },
        methodology:
          'Close rate = won / (won + lost) per industry, over all closed opportunities. Cycle length measured from creation to close on won deals only.',
        confidence: 0.9,
        sources: [],
        recordIds: [],
      };
    },
  },

  {
    id: 'objections_vs_outcome',
    label: 'Objections correlated with lost deals',
    patterns: [/objection.*(?:lost|lose|correlat|common)/i, /why.*(?:deals?|enterprise).*(?:fail|lost|slip)/i, /what objections/i],
    run: async (ctx) => {
      const rows = await rawQuery<{
        category: string;
        lost: number;
        won: number;
        open_deals: number;
      }>(ctx, sql`
        SELECT ob.category,
               COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'lost')::int AS lost,
               COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'won')::int AS won,
               COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'open')::int AS open_deals
        FROM objections ob
        JOIN opportunities o ON o.id = ob.opportunity_id
        WHERE ob.workspace_id = ${ctx.workspaceId}
          AND ob.deleted_at IS NULL
          AND o.deleted_at IS NULL
        GROUP BY 1
        ORDER BY lost DESC
      `);

      const series = rows.map((r) => {
        const closed = r.won + r.lost;
        return {
          label: r.category,
          value: closed > 0 ? Math.round((r.lost / closed) * 100) : 0,
          secondary: r.lost + r.won + r.open_deals,
        };
      });

      const worst = [...series].filter((x) => (x.secondary ?? 0) >= 2).sort((a, b) => b.value - a.value)[0];

      return {
        reportId: 'objections_vs_outcome',
        answer:
          series.length === 0
            ? 'No objections have been recorded against closed deals yet.'
            : worst
              ? `Deals where a **${worst.label}** objection was raised were lost ${worst.value}% of the time — the strongest negative signal in the data. It appears in ${worst.secondary} deals.`
              : 'Objections are recorded but not yet on enough closed deals to show a pattern.',
        chart: {
          kind: 'bar',
          title: 'Loss rate when this objection appears',
          xLabel: 'Objection',
          yLabel: 'Loss rate',
          series,
          valueFormat: 'percent',
        },
        table: {
          columns: ['Objection', 'Lost', 'Won', 'Still open', 'Loss rate %'],
          rows: rows.map((r) => [
            r.category,
            r.lost,
            r.won,
            r.open_deals,
            r.won + r.lost > 0 ? Math.round((r.lost / (r.won + r.lost)) * 100) : 0,
          ]),
        },
        methodology:
          'For each objection category, counted the distinct opportunities it was raised against, split by final status. Loss rate is over closed deals only, so still-open deals do not distort it. This is correlation, not causation — a small sample can mislead.',
        confidence: 0.75,
        sources: [],
        recordIds: [],
      };
    },
  },

  {
    id: 'product_demand_by_arr',
    label: 'Requested features by associated revenue',
    patterns: [/(?:feature|product).*(?:arr|revenue|pipeline|worth|demand)/i, /which.*features?.*(?:most|represent)/i, /most requested/i],
    run: async (ctx) => {
      const rows = await rawQuery<{
        theme: string;
        accounts: number;
        pipeline: number;
        arr: number;
      }>(ctx, sql`
        SELECT COALESCE(t.name, ps.title) AS theme,
               COUNT(DISTINCT ps.account_id)::int AS accounts,
               COALESCE(SUM(DISTINCT o.value), 0)::float8 AS pipeline,
               COALESCE(SUM(DISTINCT a.current_arr), 0)::float8 AS arr
        FROM product_signals ps
        LEFT JOIN product_signal_themes t ON t.id = ps.theme_id
        LEFT JOIN accounts a ON a.id = ps.account_id
        LEFT JOIN opportunities o ON o.id = ps.opportunity_id AND o.status = 'open'
        WHERE ps.workspace_id = ${ctx.workspaceId}
          AND ps.deleted_at IS NULL
        GROUP BY 1
        ORDER BY accounts DESC, pipeline DESC
        LIMIT 15
      `);

      const series = rows.map((r) => ({
        label: r.theme,
        value: Number(r.pipeline),
        secondary: r.accounts,
      }));
      const top = series[0];

      return {
        reportId: 'product_demand_by_arr',
        answer:
          series.length === 0
            ? 'No product requests have been extracted from conversations yet.'
            : `**${top!.label}** is the most requested capability — ${top!.secondary} accounts have asked for it, representing ${money(top!.value)} of open pipeline.`,
        chart: {
          kind: 'bar',
          title: 'Requested capabilities by open pipeline',
          xLabel: 'Capability',
          yLabel: 'Pipeline',
          series,
          valueFormat: 'currency',
        },
        table: {
          columns: ['Capability', 'Accounts', 'Open pipeline', 'Current ARR'],
          rows: rows.map((r) => [r.theme, r.accounts, Number(r.pipeline), Number(r.arr)]),
        },
        methodology:
          'Grouped extracted product signals by canonical theme, counting distinct accounts and summing the value of open opportunities attached to those signals.',
        confidence: 0.85,
        sources: [],
        recordIds: [],
      };
    },
  },

  {
    id: 'rep_conversion',
    label: 'Conversion by owner',
    patterns: [/which reps?/i, /by (?:rep|owner|salesperson)/i, /conversion.*(?:rep|owner|demo)/i],
    run: async (ctx) => {
      const rows = await rawQuery<{
        owner: string;
        won: number;
        lost: number;
        open_deals: number;
        won_value: number;
      }>(ctx, sql`
        SELECT COALESCE(u.name, 'Unassigned') AS owner,
               COUNT(*) FILTER (WHERE o.status = 'won')::int AS won,
               COUNT(*) FILTER (WHERE o.status = 'lost')::int AS lost,
               COUNT(*) FILTER (WHERE o.status = 'open')::int AS open_deals,
               COALESCE(SUM(o.value) FILTER (WHERE o.status = 'won'), 0)::float8 AS won_value
        FROM opportunities o
        LEFT JOIN users u ON u.id = o.owner_id
        WHERE o.workspace_id = ${ctx.workspaceId} AND o.deleted_at IS NULL
        GROUP BY 1
        ORDER BY won DESC
      `);

      const series = rows.map((r) => ({
        label: r.owner,
        value: r.won + r.lost > 0 ? Math.round((r.won / (r.won + r.lost)) * 100) : 0,
        secondary: r.won,
      }));
      const best = [...series].filter((x) => (x.secondary ?? 0) > 0).sort((a, b) => b.value - a.value)[0];

      return {
        reportId: 'rep_conversion',
        answer: best
          ? `${best.label} has the highest close rate at ${best.value}% across ${best.secondary} won deals.`
          : 'No closed deals yet, so conversion cannot be compared by owner.',
        chart: {
          kind: 'bar',
          title: 'Close rate by owner',
          xLabel: 'Owner',
          yLabel: 'Close rate',
          series,
          valueFormat: 'percent',
        },
        table: {
          columns: ['Owner', 'Won', 'Lost', 'Open', 'Won value', 'Close rate %'],
          rows: rows.map((r) => [
            r.owner,
            r.won,
            r.lost,
            r.open_deals,
            Number(r.won_value),
            r.won + r.lost > 0 ? Math.round((r.won / (r.won + r.lost)) * 100) : 0,
          ]),
        },
        methodology: 'Grouped all opportunities by owner. Close rate is won / (won + lost); open deals are excluded from the rate but shown for context.',
        confidence: 0.9,
        sources: [],
        recordIds: [],
      };
    },
  },

  {
    id: 'stalled_deals',
    label: 'Deals with no recent activity',
    patterns: [/no activity/i, /stalled|stale|gone (?:quiet|dark)/i, /(?:haven'?t|not) (?:heard|contacted)/i, /inactive/i],
    run: async (ctx, params) => {
      const days = params.days || 14;
      const rows = await rawQuery<{
        id: string;
        name: string;
        account: string;
        value: number;
        days_quiet: number;
        stage: string;
      }>(ctx, sql`
        SELECT o.id, o.name, a.name AS account, o.value::float8 AS value,
               COALESCE(EXTRACT(EPOCH FROM (now() - o.last_interaction_at)) / 86400, 999)::int AS days_quiet,
               st.name AS stage
        FROM opportunities o
        JOIN accounts a ON a.id = o.account_id
        JOIN pipeline_stages st ON st.id = o.stage_id
        WHERE o.workspace_id = ${ctx.workspaceId}
          AND o.deleted_at IS NULL
          AND o.status = 'open'
          AND (o.last_interaction_at IS NULL OR o.last_interaction_at < now() - (${days} || ' days')::interval)
        ORDER BY o.value DESC
        LIMIT 50
      `);

      const total = rows.reduce((s, r) => s + Number(r.value), 0);

      return {
        reportId: 'stalled_deals',
        answer:
          rows.length === 0
            ? `Every open deal has had customer activity within the last ${days} days.`
            : `${rows.length} open deal${rows.length === 1 ? '' : 's'} worth ${money(total)} have had no customer activity for ${days}+ days.`,
        chart: {
          kind: 'stat',
          title: 'At-risk pipeline',
          series: [
            { label: 'Deals', value: rows.length },
            { label: 'Value', value: total },
          ],
          valueFormat: 'currency',
        },
        table: {
          columns: ['Deal', 'Account', 'Stage', 'Value', 'Days quiet'],
          rows: rows.map((r) => [r.name, r.account, r.stage, Number(r.value), r.days_quiet]),
        },
        methodology: `Open opportunities whose most recent recorded interaction is older than ${days} days, or which have none at all.`,
        confidence: 1,
        sources: [],
        recordIds: rows.map((r) => ({ type: 'opportunity', id: r.id, label: r.name })),
      };
    },
  },

  {
    id: 'pipeline_by_stage',
    label: 'Pipeline by stage',
    patterns: [/pipeline by stage/i, /(?:how much|what).*(?:in|per) (?:each )?stage/i, /funnel/i, /pipeline overview/i],
    run: async (ctx) => {
      const rows = await rawQuery<{ stage: string; deals: number; total: number; position: number }>(ctx, sql`
        SELECT st.name AS stage, COUNT(o.id)::int AS deals,
               COALESCE(SUM(o.value), 0)::float8 AS total, st.position::int AS position
        FROM pipeline_stages st
        LEFT JOIN opportunities o
          ON o.stage_id = st.id AND o.deleted_at IS NULL AND o.status = 'open'
        WHERE st.workspace_id = ${ctx.workspaceId}
        GROUP BY st.name, st.position
        ORDER BY st.position
      `);

      const series = rows.map((r) => ({ label: r.stage, value: Number(r.total), secondary: r.deals }));
      const total = series.reduce((s, p) => s + p.value, 0);

      return {
        reportId: 'pipeline_by_stage',
        answer: `${money(total)} of open pipeline across ${series.reduce((s, p) => s + (p.secondary ?? 0), 0)} deals. The largest concentration is in ${best(series)}.`,
        chart: {
          kind: 'bar',
          title: 'Open pipeline by stage',
          xLabel: 'Stage',
          yLabel: 'Value',
          series,
          valueFormat: 'currency',
        },
        table: {
          columns: ['Stage', 'Deals', 'Value'],
          rows: series.map((p) => [p.label, p.secondary ?? 0, p.value]),
        },
        methodology: 'Summed the value of open, non-deleted opportunities grouped by pipeline stage, ordered by stage position.',
        confidence: 1,
        sources: [],
        recordIds: [],
      };
    },
  },

  {
    id: 'security_cycle_impact',
    label: 'Effect of a security review on cycle length',
    patterns: [/security review.*(?:longer|slow|impact|take)/i, /(?:enterprise )?deals.*security/i, /soc ?2.*(?:longer|slow)/i],
    run: async (ctx) => {
      const rows = await rawQuery<{ with_security: number; avg_days: number; deals: number }>(ctx, sql`
        WITH flagged AS (
          SELECT o.id,
                 EXTRACT(EPOCH FROM (COALESCE(o.closed_at, now()) - o.created_at)) / 86400 AS cycle_days,
                 EXISTS (
                   SELECT 1 FROM objections ob
                   WHERE ob.opportunity_id = o.id
                     AND ob.category IN ('security', 'compliance')
                     AND ob.deleted_at IS NULL
                 ) AS has_security
          FROM opportunities o
          WHERE o.workspace_id = ${ctx.workspaceId} AND o.deleted_at IS NULL
        )
        SELECT has_security::int AS with_security,
               AVG(cycle_days)::float8 AS avg_days,
               COUNT(*)::int AS deals
        FROM flagged GROUP BY 1
      `);

      const withSec = rows.find((r) => r.with_security === 1);
      const without = rows.find((r) => r.with_security === 0);
      const delta =
        withSec && without ? Math.round(Number(withSec.avg_days) - Number(without.avg_days)) : null;

      return {
        reportId: 'security_cycle_impact',
        answer:
          delta === null
            ? 'There are not yet deals on both sides of this comparison.'
            : delta > 0
              ? `Deals where a security or compliance review came up take **${delta} days longer** on average (${Math.round(Number(withSec!.avg_days))} vs ${Math.round(Number(without!.avg_days))} days), across ${withSec!.deals} and ${without!.deals} deals respectively.`
              : `Security reviews are not lengthening cycles in this data (${Math.abs(delta)} days shorter on average).`,
        chart: {
          kind: 'bar',
          title: 'Average cycle length (days)',
          series: [
            { label: 'Security review raised', value: Math.round(Number(withSec?.avg_days ?? 0)) },
            { label: 'No security review', value: Math.round(Number(without?.avg_days ?? 0)) },
          ],
          valueFormat: 'days',
        },
        table: {
          columns: ['Cohort', 'Deals', 'Avg cycle days'],
          rows: [
            ['Security review raised', withSec?.deals ?? 0, Math.round(Number(withSec?.avg_days ?? 0))],
            ['No security review', without?.deals ?? 0, Math.round(Number(without?.avg_days ?? 0))],
          ],
        },
        methodology:
          'Split opportunities by whether a security or compliance objection was ever recorded, then compared mean days from creation to close (or to today for open deals). Small cohorts make this indicative rather than conclusive.',
        confidence: 0.7,
        sources: [],
        recordIds: [],
      };
    },
  },
  {
    id: 'churn_risk',
    label: 'Customers at risk of churning',
    patterns: [
      /churn|at risk of (?:leaving|cancelling|canceling)|retention risk/i,
      /(?:which|what) (?:customers|accounts).*(?:risk|leaving|renew)/i,
      /renewal risk/i,
      /(?:usage|adoption) (?:is )?(?:falling|dropping|declining)/i,
    ],
    run: async (ctx) => {
      // Deliberately multi-signal: usage collapse, urgent tickets, churn
      // language and silence each mean something on their own, and an account
      // showing several is a different conversation from one showing one.
      const rows = await rawQuery<{
        id: string;
        name: string;
        arr: number | null;
        recent_users: number;
        prior_users: number;
        urgent_tickets: number;
        churn_flags: number;
        days_quiet: number;
        health: number | null;
      }>(ctx, sql`
        SELECT a.id, a.name, a.current_arr::float8 AS arr,
               COALESCE((
                 SELECT AVG(u.active_users) FROM usage_daily u
                 WHERE u.account_id = a.id AND u.contact_id IS NULL
                   AND u.day >= now() - interval '30 days'
               ), 0)::float8 AS recent_users,
               COALESCE((
                 SELECT AVG(u.active_users) FROM usage_daily u
                 WHERE u.account_id = a.id AND u.contact_id IS NULL
                   AND u.day < now() - interval '30 days'
                   AND u.day >= now() - interval '60 days'
               ), 0)::float8 AS prior_users,
               COALESCE((
                 SELECT COUNT(*) FROM support_tickets t
                 WHERE t.account_id = a.id AND t.deleted_at IS NULL
                   AND t.status IN ('open', 'pending') AND t.priority = 'urgent'
               ), 0)::int AS urgent_tickets,
               COALESCE((
                 SELECT COUNT(*) FROM objections ob
                 WHERE ob.account_id = a.id AND ob.deleted_at IS NULL
                   AND ob.status = 'open' AND ob.severity = 'high'
               ), 0)::int AS churn_flags,
               COALESCE(EXTRACT(EPOCH FROM (now() - a.last_interaction_at)) / 86400, 999)::int AS days_quiet,
               a.health_score AS health
        FROM accounts a
        WHERE a.workspace_id = ${ctx.workspaceId}
          AND a.deleted_at IS NULL
          AND a.lifecycle_stage = 'customer'
        ORDER BY a.current_arr DESC NULLS LAST
      `);

      const atRisk = rows
        .map((r) => {
          const reasons: string[] = [];
          if (r.prior_users >= 2 && r.recent_users < 1) {
            reasons.push(`product usage went dormant (${Math.round(r.prior_users)} → 0 daily active users)`);
          } else if (r.prior_users >= 2 && r.recent_users < r.prior_users * 0.7) {
            reasons.push(
              `product usage fell from ${Math.round(r.prior_users)} to ${Math.round(r.recent_users)} daily active users`,
            );
          }
          if (r.urgent_tickets > 0) {
            reasons.push(`${r.urgent_tickets} urgent support ticket${r.urgent_tickets === 1 ? '' : 's'} open`);
          }
          if (r.churn_flags > 0) {
            reasons.push(`${r.churn_flags} unresolved high-severity concern${r.churn_flags === 1 ? '' : 's'}`);
          }
          if (r.days_quiet >= 30 && r.days_quiet < 999) {
            reasons.push(`no contact for ${r.days_quiet} days`);
          }
          return { ...r, reasons };
        })
        .filter((r) => r.reasons.length > 0)
        .sort((a, b) => b.reasons.length - a.reasons.length || (Number(b.arr) || 0) - (Number(a.arr) || 0));

      const exposed = atRisk.reduce((sum, r) => sum + (Number(r.arr) || 0), 0);

      return {
        reportId: 'churn_risk',
        answer:
          atRisk.length === 0
            ? 'No customer is showing a retention signal right now: usage is holding, no urgent tickets are open, and nobody has gone quiet.'
            : `${atRisk.length} customer${atRisk.length === 1 ? '' : 's'} representing ${money(exposed)} of ARR ${
                atRisk.length === 1 ? 'is' : 'are'
              } showing retention signals. ${atRisk
                .slice(0, 3)
                .map((r) => `${r.name} — ${r.reasons.join('; ')}`)
                .join('. ')}.`,
        chart: {
          kind: 'bar',
          title: 'ARR exposed, by account',
          series: atRisk.slice(0, 8).map((r) => ({ label: r.name, value: Number(r.arr) || 0 })),
          valueFormat: 'currency',
        },
        table: {
          columns: ['Account', 'ARR', 'Health', 'Signals', 'Why'],
          rows: atRisk.map((r) => [
            r.name,
            Number(r.arr) || 0,
            r.health ?? '—',
            r.reasons.length,
            r.reasons.join('; '),
          ]),
        },
        methodology:
          'Customer accounts showing at least one retention signal: a 30%+ drop in daily active users versus the previous 30 days, an open urgent support ticket, an unresolved high-severity concern, or 30+ days of silence. Ordered by how many signals coincide, then by ARR.',
        confidence: 1,
        sources: [],
        recordIds: atRisk.map((r) => ({ type: 'account', id: r.id, label: r.name })),
      };
    },
  },
];

/* ── Routing ──────────────────────────────────────────────────────────────── */

/** Match a question to a report template. Returns null when nothing fits. */
export async function runAnalyticsQuestion(ctx: Ctx, question: string): Promise<AnalyticsResult | null> {
  const report = REPORTS.find((r) => r.patterns.some((p) => p.test(question)));
  if (!report) return null;

  const months = Number(/(\d+)\s*months?/i.exec(question)?.[1] ?? 12);
  const days = Number(/(\d+)\s*days?/i.exec(question)?.[1] ?? 0);

  return report.run(ctx, {
    question,
    months: Math.min(Math.max(months, 1), 36),
    days: Math.min(Math.max(days, 0), 365),
  });
}

export function listReports(): { id: string; label: string; example: string }[] {
  return [
    { id: 'pipeline_created_by_month', label: 'Pipeline created by month', example: 'Pipeline created by month' },
    { id: 'pipeline_by_stage', label: 'Pipeline by stage', example: 'How much pipeline is in each stage?' },
    { id: 'win_rate_by_industry', label: 'Close rate by industry', example: 'Which industries close fastest?' },
    { id: 'objections_vs_outcome', label: 'Objections vs outcomes', example: 'What objections correlate with lost deals?' },
    { id: 'product_demand_by_arr', label: 'Product demand by revenue', example: 'Which requested features represent the most ARR?' },
    { id: 'rep_conversion', label: 'Conversion by owner', example: 'Which reps have the highest conversion?' },
    { id: 'stalled_deals', label: 'Stalled deals', example: 'Show opportunities with no activity for 14 days' },
    { id: 'security_cycle_impact', label: 'Security review impact', example: 'Do security reviews slow deals down?' },
    { id: 'churn_risk', label: 'Customers at risk', example: 'Which customers are at risk of churning?' },
  ];
}

export async function runReportById(ctx: Ctx, reportId: string, params?: Partial<ReportParams>) {
  const report = REPORTS.find((r) => r.id === reportId);
  if (!report) return null;
  return report.run(ctx, {
    question: params?.question ?? report.label,
    months: params?.months ?? 12,
    days: params?.days ?? 0,
  });
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function money(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function best(series: { label: string; value: number }[]): string {
  const top = [...series].sort((a, b) => b.value - a.value)[0];
  return top ? `${top.label} (${money(top.value)})` : 'none';
}
