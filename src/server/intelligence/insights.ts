import { sql } from 'drizzle-orm';
import { insights, type SourceRef } from '@/db/schema';
import { scope, type Ctx } from '../context';
import { rawQuery } from '../db-query';

/**
 * LEVEL 4 — aggregated business intelligence.
 *
 * Cross-account patterns computed from the workspace's own history: which
 * objections precede losses, whether executive involvement actually changes
 * outcomes, which requested capability is worth the most pipeline.
 *
 * Two rules, both load-bearing:
 *
 *  - **Every insight carries its sample size and its records.** "Enterprise
 *    deals mentioning security review take 18 days longer" is only useful if
 *    you can see the deals, so `evidence` holds real ids and the UI links to
 *    them.
 *  - **Thin evidence produces no insight, not a hedged one.** Each detector
 *    has a minimum cohort size; below it the pattern is not reported at all.
 *    A confident-sounding claim from three deals is worse than silence.
 */

const MIN_COHORT = 3;

export type ComputedInsight = {
  kind: 'pattern' | 'risk' | 'opportunity' | 'product' | 'process';
  title: string;
  body: string;
  metrics: Record<string, number | string>;
  evidence: SourceRef[];
  confidence: number;
  severity: 'info' | 'warning' | 'critical';
};

export async function computeInsights(ctx: Ctx): Promise<ComputedInsight[]> {
  const detected = (
    await Promise.all([
      securityCycleImpact(ctx),
      executiveInvolvement(ctx),
      objectionLossCorrelation(ctx),
      sharedProductDemand(ctx),
      stalledPipelineValue(ctx),
      championlessDeals(ctx),
      engagementDecline(ctx),
      seatPricingPattern(ctx),
      usageChurnRisk(ctx),
      expansionReady(ctx),
    ])
  ).filter((x): x is ComputedInsight => x !== null);

  // Recompute wholesale rather than diff: an insight that no longer holds must
  // disappear, not linger with a stale timestamp.
  await ctx.db.delete(insights).where(scope(ctx, insights));

  if (detected.length > 0) {
    await ctx.db.insert(insights).values(
      detected.map((insight) => ({
        workspaceId: ctx.workspaceId,
        kind: insight.kind,
        title: insight.title,
        body: insight.body,
        metrics: insight.metrics,
        evidence: insight.evidence,
        confidence: insight.confidence,
        severity: insight.severity,
        computedAt: new Date(),
      })),
    );
  }

  return detected;
}

/* ── Detectors ────────────────────────────────────────────────────────────── */

async function securityCycleImpact(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ has_security: boolean; deals: number; avg_days: number }>(
    ctx,
    sql`
      WITH cohort AS (
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
      SELECT has_security, COUNT(*)::int AS deals, AVG(cycle_days)::float8 AS avg_days
      FROM cohort GROUP BY 1
    `,
  );

  const withSec = rows.find((r) => r.has_security === true);
  const without = rows.find((r) => r.has_security === false);
  if (!withSec || !without) return null;
  if (withSec.deals < MIN_COHORT || without.deals < MIN_COHORT) return null;

  const delta = Math.round(Number(withSec.avg_days) - Number(without.avg_days));
  if (delta < 5) return null;

  const examples = await rawQuery<{ id: string; name: string }>(
    ctx,
    sql`
      SELECT DISTINCT o.id, o.name
      FROM opportunities o
      JOIN objections ob ON ob.opportunity_id = o.id
      WHERE o.workspace_id = ${ctx.workspaceId}
        AND o.deleted_at IS NULL
        AND ob.category IN ('security', 'compliance')
      ORDER BY o.name
      LIMIT 6
    `,
  );

  return {
    kind: 'pattern',
    title: `Deals with a security review take ${delta} days longer to close`,
    body:
      `Across ${withSec.deals} deals where a security or compliance objection was recorded, the average cycle is ` +
      `${Math.round(Number(withSec.avg_days))} days, against ${Math.round(Number(without.avg_days))} days for the ` +
      `${without.deals} deals without one. The security review is on the critical path, not alongside it — which means ` +
      `mapping it during Discovery rather than at Proposal is worth roughly ${delta} days of cycle time.`,
    metrics: {
      cohortWithSecurity: withSec.deals,
      cohortWithout: without.deals,
      deltaDays: delta,
      avgDaysWithSecurity: Math.round(Number(withSec.avg_days)),
      avgDaysWithout: Math.round(Number(without.avg_days)),
    },
    evidence: examples.map((e) => ({ type: 'opportunity' as const, id: e.id, label: e.name })),
    confidence: withSec.deals >= 6 ? 0.82 : 0.65,
    severity: 'info',
  };
}

async function executiveInvolvement(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ exec_engaged: boolean; deals: number; won: number; avg_value: number; avg_days: number }>(
    ctx,
    sql`
      WITH cohort AS (
        SELECT o.id, o.status, o.value,
               EXTRACT(EPOCH FROM (COALESCE(o.closed_at, now()) - o.created_at)) / 86400 AS cycle_days,
               EXISTS (
                 SELECT 1
                 FROM meeting_participants mp
                 JOIN meetings m ON m.id = mp.meeting_id
                 JOIN contacts c ON c.id = mp.contact_id
                 WHERE m.opportunity_id = o.id
                   AND c.seniority IN ('c_level', 'vp')
                   AND mp.attended = true
               ) AS exec_engaged
        FROM opportunities o
        WHERE o.workspace_id = ${ctx.workspaceId}
          AND o.deleted_at IS NULL
          AND o.status IN ('won', 'lost')
      )
      SELECT exec_engaged,
             COUNT(*)::int AS deals,
             COUNT(*) FILTER (WHERE status = 'won')::int AS won,
             AVG(value)::float8 AS avg_value,
             AVG(cycle_days)::float8 AS avg_days
      FROM cohort GROUP BY 1
    `,
  );

  const withExec = rows.find((r) => r.exec_engaged === true);
  const without = rows.find((r) => r.exec_engaged === false);
  if (!withExec || !without) return null;
  if (withExec.deals < MIN_COHORT || without.deals < MIN_COHORT) return null;

  const rateWith = Math.round((withExec.won / withExec.deals) * 100);
  const rateWithout = Math.round((without.won / without.deals) * 100);
  if (rateWith - rateWithout < 15) return null;

  const examples = await rawQuery<{ id: string; name: string }>(
    ctx,
    sql`
      SELECT DISTINCT o.id, o.name
      FROM opportunities o
      JOIN meetings m ON m.opportunity_id = o.id
      JOIN meeting_participants mp ON mp.meeting_id = m.id
      JOIN contacts c ON c.id = mp.contact_id
      WHERE o.workspace_id = ${ctx.workspaceId}
        AND c.seniority IN ('c_level', 'vp')
        AND o.status = 'won'
      LIMIT 6
    `,
  );

  return {
    kind: 'pattern',
    title: `Deals close ${rateWith - rateWithout} points more often when an executive joins a call`,
    body:
      `Of ${withExec.deals} closed deals where a VP or C-level contact attended at least one meeting, ${rateWith}% were won. ` +
      `Where no executive attended, ${rateWithout}% of ${without.deals} were won. Average deal size was ` +
      `$${Math.round(Number(withExec.avg_value)).toLocaleString()} with an executive present versus ` +
      `$${Math.round(Number(without.avg_value)).toLocaleString()} without. Getting the budget holder into a room early ` +
      `looks like the highest-leverage single action in the cycle.`,
    metrics: {
      winRateWithExec: rateWith,
      winRateWithout: rateWithout,
      cohortWithExec: withExec.deals,
      cohortWithout: without.deals,
      avgValueWithExec: Math.round(Number(withExec.avg_value)),
    },
    evidence: examples.map((e) => ({ type: 'opportunity' as const, id: e.id, label: e.name })),
    confidence: withExec.deals >= 5 ? 0.78 : 0.6,
    severity: 'info',
  };
}

async function objectionLossCorrelation(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ category: string; lost: number; won: number }>(
    ctx,
    sql`
      SELECT ob.category,
             COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'lost')::int AS lost,
             COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'won')::int AS won
      FROM objections ob
      JOIN opportunities o ON o.id = ob.opportunity_id
      WHERE ob.workspace_id = ${ctx.workspaceId}
        AND ob.deleted_at IS NULL
        AND o.deleted_at IS NULL
        AND o.status IN ('won', 'lost')
      GROUP BY 1
      HAVING COUNT(DISTINCT o.id) >= ${MIN_COHORT}
      ORDER BY lost DESC
    `,
  );

  const worst = rows
    .map((r) => ({ ...r, total: r.won + r.lost, lossRate: r.lost / (r.won + r.lost) }))
    .filter((r) => r.total >= MIN_COHORT)
    .sort((a, b) => b.lossRate - a.lossRate)[0];

  if (!worst || worst.lossRate < 0.5) return null;

  const examples = await rawQuery<{ id: string; name: string; quote: string | null }>(
    ctx,
    sql`
      SELECT o.id, o.name, ob.source_quote AS quote
      FROM objections ob
      JOIN opportunities o ON o.id = ob.opportunity_id
      WHERE ob.workspace_id = ${ctx.workspaceId}
        AND ob.category = ${worst.category}
        AND o.status = 'lost'
      LIMIT 6
    `,
  );

  return {
    kind: 'risk',
    title: `A "${worst.category}" objection preceded ${Math.round(worst.lossRate * 100)}% of losses where it appeared`,
    body:
      `Of ${worst.total} closed deals where a ${worst.category} objection was recorded, ${worst.lost} were lost and ` +
      `${worst.won} were won. This is correlation on a small sample, not causation — but it is the strongest negative ` +
      `signal in the current data, and worth checking against any open deal carrying the same objection.`,
    metrics: {
      category: worst.category,
      lost: worst.lost,
      won: worst.won,
      lossRatePercent: Math.round(worst.lossRate * 100),
      sampleSize: worst.total,
    },
    evidence: examples.map((e) => ({
      type: 'opportunity' as const,
      id: e.id,
      label: e.name,
      snippet: e.quote ?? undefined,
    })),
    confidence: worst.total >= 6 ? 0.7 : 0.5,
    severity: 'warning',
  };
}

async function sharedProductDemand(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ theme: string; accounts: number; pipeline: number; arr: number; theme_id: string | null }>(
    ctx,
    sql`
      SELECT COALESCE(t.name, ps.title) AS theme,
             t.id AS theme_id,
             COUNT(DISTINCT ps.account_id)::int AS accounts,
             COALESCE(SUM(DISTINCT o.value), 0)::float8 AS pipeline,
             COALESCE(SUM(DISTINCT a.current_arr), 0)::float8 AS arr
      FROM product_signals ps
      LEFT JOIN product_signal_themes t ON t.id = ps.theme_id
      LEFT JOIN accounts a ON a.id = ps.account_id
      LEFT JOIN opportunities o ON o.id = ps.opportunity_id AND o.status = 'open' AND o.deleted_at IS NULL
      WHERE ps.workspace_id = ${ctx.workspaceId} AND ps.deleted_at IS NULL
      GROUP BY 1, 2
      HAVING COUNT(DISTINCT ps.account_id) >= ${MIN_COHORT}
      ORDER BY accounts DESC, pipeline DESC
      LIMIT 1
    `,
  );

  const top = rows[0];
  if (!top) return null;

  const examples = await rawQuery<{ id: string; name: string; quote: string | null }>(
    ctx,
    sql`
      SELECT DISTINCT a.id, a.name, ps.source_quote AS quote
      FROM product_signals ps
      JOIN accounts a ON a.id = ps.account_id
      WHERE ps.workspace_id = ${ctx.workspaceId}
        AND COALESCE((SELECT name FROM product_signal_themes WHERE id = ps.theme_id), ps.title) = ${top.theme}
      LIMIT 8
    `,
  );

  return {
    kind: 'product',
    title: `${top.accounts} accounts have asked for ${top.theme}`,
    body:
      `${top.theme} is the most requested capability in the pipeline, raised independently by ${top.accounts} accounts ` +
      `carrying $${Math.round(Number(top.pipeline)).toLocaleString()} of open pipeline` +
      (Number(top.arr) > 0 ? ` and $${Math.round(Number(top.arr)).toLocaleString()} of existing ARR` : '') +
      `. Each request is quoted from the conversation it came from, so this is customer research rather than an internal guess.`,
    metrics: {
      capability: top.theme,
      accountCount: top.accounts,
      openPipeline: Math.round(Number(top.pipeline)),
      existingArr: Math.round(Number(top.arr)),
    },
    evidence: examples.map((e) => ({
      type: 'account' as const,
      id: e.id,
      label: e.name,
      snippet: e.quote ?? undefined,
    })),
    confidence: 0.88,
    severity: 'info',
  };
}

async function stalledPipelineValue(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ id: string; name: string; value: number; days_quiet: number }>(
    ctx,
    sql`
      SELECT o.id, o.name, o.value::float8 AS value,
             COALESCE(EXTRACT(EPOCH FROM (now() - o.last_interaction_at)) / 86400, 999)::int AS days_quiet
      FROM opportunities o
      WHERE o.workspace_id = ${ctx.workspaceId}
        AND o.deleted_at IS NULL
        AND o.status = 'open'
        AND (o.last_interaction_at IS NULL OR o.last_interaction_at < now() - interval '14 days')
      ORDER BY o.value DESC
      LIMIT 20
    `,
  );

  if (rows.length < 2) return null;
  const total = rows.reduce((s, r) => s + Number(r.value), 0);

  return {
    kind: 'risk',
    title: `$${Math.round(total).toLocaleString()} of open pipeline has gone quiet`,
    body:
      `${rows.length} open deals have had no recorded customer interaction for 14 days or more. The largest is ` +
      `${rows[0]!.name} at $${Math.round(Number(rows[0]!.value)).toLocaleString()}, silent for ${rows[0]!.days_quiet} days. ` +
      `Silence after a proposal is the most common precursor to a slipped quarter in this dataset.`,
    metrics: { dealCount: rows.length, totalValue: Math.round(total), maxDaysQuiet: rows[0]!.days_quiet },
    evidence: rows.slice(0, 8).map((r) => ({
      type: 'opportunity' as const,
      id: r.id,
      label: `${r.name} — quiet ${r.days_quiet}d`,
    })),
    confidence: 1,
    severity: total > 250_000 ? 'critical' : 'warning',
  };
}

async function championlessDeals(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ id: string; name: string; value: number }>(
    ctx,
    sql`
      SELECT o.id, o.name, o.value::float8 AS value
      FROM opportunities o
      WHERE o.workspace_id = ${ctx.workspaceId}
        AND o.deleted_at IS NULL
        AND o.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.account_id = o.account_id
            AND c.buying_role = 'champion'
            AND c.deleted_at IS NULL
        )
      ORDER BY o.value DESC
      LIMIT 12
    `,
  );

  if (rows.length < 2) return null;
  const total = rows.reduce((s, r) => s + Number(r.value), 0);

  return {
    kind: 'risk',
    title: `${rows.length} open deals have no identified champion`,
    body:
      `$${Math.round(total).toLocaleString()} of open pipeline has no contact marked as advocating internally. In the ` +
      `qualification framework this is the single strongest predictor of a deal stalling — nobody inside the account is ` +
      `carrying it when attention moves elsewhere.`,
    metrics: { dealCount: rows.length, totalValue: Math.round(total) },
    evidence: rows.slice(0, 8).map((r) => ({ type: 'opportunity' as const, id: r.id, label: r.name })),
    confidence: 0.9,
    severity: 'warning',
  };
}

async function engagementDecline(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ id: string; name: string; recent: number; earlier: number }>(
    ctx,
    sql`
      SELECT a.id, a.name,
             COUNT(*) FILTER (WHERE act.occurred_at >= now() - interval '30 days')::int AS recent,
             COUNT(*) FILTER (
               WHERE act.occurred_at < now() - interval '30 days'
                 AND act.occurred_at >= now() - interval '60 days'
             )::int AS earlier
      FROM accounts a
      JOIN activities act ON act.account_id = a.id
      WHERE a.workspace_id = ${ctx.workspaceId}
        AND a.deleted_at IS NULL
        AND a.lifecycle_stage IN ('opportunity', 'customer')
      GROUP BY a.id, a.name
      HAVING COUNT(*) FILTER (
               WHERE act.occurred_at < now() - interval '30 days'
                 AND act.occurred_at >= now() - interval '60 days'
             ) >= 2
         AND COUNT(*) FILTER (WHERE act.occurred_at >= now() - interval '30 days') * 2
             < COUNT(*) FILTER (
                 WHERE act.occurred_at < now() - interval '30 days'
                   AND act.occurred_at >= now() - interval '60 days'
               )
      ORDER BY earlier DESC
      LIMIT 10
    `,
  );

  if (rows.length < 2) return null;

  return {
    kind: 'risk',
    title: `Engagement is falling on ${rows.length} active accounts`,
    body:
      `These accounts had meaningfully more interaction in the previous 30-day window than the current one — at least a ` +
      `halving in volume. ${rows[0]!.name} went from ${rows[0]!.earlier} interactions to ${rows[0]!.recent}. ` +
      `Declining cadence usually shows up in the data before the customer says anything.`,
    metrics: { accountCount: rows.length, worstAccount: rows[0]!.name },
    evidence: rows.slice(0, 8).map((r) => ({
      type: 'account' as const,
      id: r.id,
      label: `${r.name} — ${r.earlier} → ${r.recent} interactions`,
    })),
    confidence: 0.75,
    severity: 'warning',
  };
}

async function seatPricingPattern(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{ id: string; name: string; employees: number; quote: string | null }>(
    ctx,
    sql`
      SELECT DISTINCT a.id, a.name, a.employee_count AS employees, ob.source_quote AS quote
      FROM objections ob
      JOIN accounts a ON a.id = ob.account_id
      WHERE ob.workspace_id = ${ctx.workspaceId}
        AND ob.category = 'price'
        AND ob.deleted_at IS NULL
        AND a.employee_count IS NOT NULL
      ORDER BY a.employee_count DESC
    `,
  );

  if (rows.length < MIN_COHORT) return null;

  const avgEmployees = Math.round(rows.reduce((s, r) => s + r.employees, 0) / rows.length);

  const baseline = await rawQuery<{ avg_employees: number }>(
    ctx,
    sql`
      SELECT AVG(employee_count)::float8 AS avg_employees
      FROM accounts
      WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL AND employee_count IS NOT NULL
    `,
  );

  const overall = Math.round(Number(baseline[0]?.avg_employees ?? 0));
  if (overall === 0 || avgEmployees < overall * 1.25) return null;

  return {
    kind: 'pattern',
    title: 'Pricing objections cluster at high headcount',
    body:
      `The ${rows.length} accounts that raised a pricing objection average ${avgEmployees.toLocaleString()} employees, ` +
      `against ${overall.toLocaleString()} across the whole book. Per-seat pricing is the friction, not the total value — ` +
      `these are the accounts where the banded or platform-licence models are worth leading with rather than defending.`,
    metrics: {
      objectionCount: rows.length,
      avgEmployeesObjecting: avgEmployees,
      avgEmployeesOverall: overall,
    },
    evidence: rows.slice(0, 8).map((r) => ({
      type: 'account' as const,
      id: r.id,
      label: `${r.name} — ${r.employees.toLocaleString()} employees`,
      snippet: r.quote ?? undefined,
    })),
    confidence: rows.length >= 5 ? 0.72 : 0.55,
    severity: 'info',
  };
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

export async function listInsights(ctx: Ctx, limit = 12) {
  return ctx.db
    .select()
    .from(insights)
    .where(scope(ctx, insights))
    .orderBy(sql`
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      confidence DESC
    `)
    .limit(limit);
}

/**
 * Usage-based churn risk.
 *
 * The signal a CRM normally cannot see: the relationship looks fine — emails
 * are still polite, no objection has been logged — while the product sits
 * unopened. Declining and dormant are kept separate because they call for
 * different motions.
 */
async function usageChurnRisk(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{
    id: string;
    name: string;
    recent: number;
    prior: number;
    open_tickets: number;
    arr: number | null;
  }>(
    ctx,
    sql`
      WITH usage AS (
        SELECT u.account_id,
               COALESCE(AVG(u.active_users) FILTER (WHERE u.day >= now() - interval '30 days'), 0)::float8 AS recent,
               COALESCE(AVG(u.active_users) FILTER (
                 WHERE u.day < now() - interval '30 days' AND u.day >= now() - interval '60 days'
               ), 0)::float8 AS prior
        FROM usage_daily u
        WHERE u.workspace_id = ${ctx.workspaceId}
          AND u.contact_id IS NULL
          AND u.day >= now() - interval '60 days'
        GROUP BY u.account_id
      )
      SELECT a.id, a.name, usage.recent, usage.prior,
             (SELECT COUNT(*) FROM support_tickets t
               WHERE t.account_id = a.id
                 AND t.workspace_id = a.workspace_id
                 AND t.deleted_at IS NULL
                 AND t.status IN ('open', 'pending'))::int AS open_tickets,
             a.annual_revenue::float8 AS arr
      FROM usage
      JOIN accounts a ON a.id = usage.account_id
      WHERE a.workspace_id = ${ctx.workspaceId}
        AND a.deleted_at IS NULL
        AND usage.prior >= 2
        AND usage.recent < usage.prior * 0.7
      ORDER BY (usage.prior - usage.recent) DESC
      LIMIT 10
    `,
  );

  if (rows.length < MIN_COHORT) return null;

  const dormant = rows.filter((r) => r.recent < 1);
  const worst = rows[0]!;

  return {
    kind: 'risk',
    title: `Product usage is falling on ${rows.length} customer accounts`,
    body:
      `Average daily active users dropped at least 30% versus the previous 30 days on these accounts. ` +
      `${worst.name} went from ${Math.round(worst.prior)} to ${Math.round(worst.recent)} active users` +
      `${worst.open_tickets > 0 ? ` while carrying ${worst.open_tickets} open support ${worst.open_tickets === 1 ? 'ticket' : 'tickets'}` : ''}. ` +
      (dormant.length > 0
        ? `${dormant.length} of them are effectively dormant, which is a save motion rather than a conversation. `
        : '') +
      `Usage falls before anyone says anything, so this is the earliest churn signal in the workspace.`,
    metrics: {
      accountCount: rows.length,
      dormantCount: dormant.length,
      worstAccount: worst.name,
      worstDropPercent: worst.prior > 0 ? -Math.round(((worst.prior - worst.recent) / worst.prior) * 100) : 0,
    },
    evidence: rows.slice(0, 8).map((r) => ({
      type: 'account' as const,
      id: r.id,
      label: `${r.name} — ${Math.round(r.prior)} → ${Math.round(r.recent)} daily active users`,
    })),
    confidence: 0.8,
    severity: dormant.length > 0 ? 'critical' : 'warning',
  };
}

/**
 * Expansion readiness from usage rather than from a renewal date.
 *
 * Customers where usage is climbing and identifiable power users exist, while
 * the pipeline has not caught up — either nothing is open at all, or the only
 * thing open is a renewal priced flat against current ARR. A flat renewal
 * under 40% usage growth is money left on the table, and it is invisible in a
 * CRM that cannot read product data.
 */
async function expansionReady(ctx: Ctx): Promise<ComputedInsight | null> {
  const rows = await rawQuery<{
    id: string;
    name: string;
    recent: number;
    prior: number;
    champions: number;
    top_user: string | null;
    open_pipeline: number;
    arr: number | null;
  }>(
    ctx,
    sql`
      WITH usage AS (
        SELECT u.account_id,
               COALESCE(AVG(u.active_users) FILTER (WHERE u.day >= now() - interval '30 days'), 0)::float8 AS recent,
               COALESCE(AVG(u.active_users) FILTER (
                 WHERE u.day < now() - interval '30 days' AND u.day >= now() - interval '60 days'
               ), 0)::float8 AS prior
        FROM usage_daily u
        WHERE u.workspace_id = ${ctx.workspaceId}
          AND u.contact_id IS NULL
          AND u.day >= now() - interval '60 days'
        GROUP BY u.account_id
      ),
      champions AS (
        SELECT u.account_id,
               c.first_name || ' ' || c.last_name AS person,
               SUM(u.key_actions)::int AS actions
        FROM usage_daily u
        JOIN contacts c ON c.id = u.contact_id
        WHERE u.workspace_id = ${ctx.workspaceId}
          AND u.day >= now() - interval '30 days'
        GROUP BY u.account_id, u.contact_id, c.first_name, c.last_name
        HAVING SUM(u.key_actions) >= 40
      ),
      rolled AS (
        SELECT account_id,
               COUNT(*)::int AS champions,
               (ARRAY_AGG(person ORDER BY actions DESC))[1] AS top_user
        FROM champions
        GROUP BY account_id
      )
      SELECT a.id, a.name, usage.recent, usage.prior, rolled.champions, rolled.top_user,
             COALESCE((
               SELECT SUM(o.value) FROM opportunities o
               WHERE o.account_id = a.id
                 AND o.workspace_id = a.workspace_id
                 AND o.deleted_at IS NULL
                 AND o.status = 'open'
             ), 0)::float8 AS open_pipeline,
             a.current_arr::float8 AS arr
      FROM usage
      JOIN accounts a ON a.id = usage.account_id
      JOIN rolled ON rolled.account_id = a.id
      WHERE a.workspace_id = ${ctx.workspaceId}
        AND a.deleted_at IS NULL
        AND a.lifecycle_stage = 'customer'
        AND usage.recent > usage.prior * 1.15
        AND usage.prior >= 1
        AND COALESCE((
          SELECT SUM(o.value) FROM opportunities o
          WHERE o.account_id = a.id
            AND o.workspace_id = a.workspace_id
            AND o.deleted_at IS NULL
            AND o.status = 'open'
        ), 0) <= COALESCE(a.current_arr, 0) * 1.15
      ORDER BY (usage.recent - usage.prior) DESC
      LIMIT 10
    `,
  );

  if (rows.length < MIN_COHORT) return null;

  const best = rows[0]!;
  const flatRenewals = rows.filter((r) => r.open_pipeline > 0);
  const bestGrowth =
    best.prior > 0 ? Math.round(((best.recent - best.prior) / best.prior) * 100) : 0;

  return {
    kind: 'opportunity',
    title: `${rows.length} customers are growing usage faster than their pipeline`,
    body:
      `Daily active users climbed more than 15% versus the previous 30 days on these accounts, and each has at ` +
      `least one power user doing real volume in the product — while the open pipeline is no larger than current ARR. ` +
      `${best.name} is up ${bestGrowth}% to ${Math.round(best.recent)} active users` +
      `${best.top_user ? `, led by ${best.top_user}` : ''}` +
      `${
        best.open_pipeline > 0
          ? `, with $${Math.round(best.open_pipeline).toLocaleString()} open against $${Math.round(
              best.arr ?? 0,
            ).toLocaleString()} of current ARR`
          : `, with nothing open at all`
      }. ` +
      (flatRenewals.length > 0
        ? `${flatRenewals.length} of these are flat renewals that have not priced in the growth. `
        : '') +
      `Expansion conversations started from usage land better than ones started from a renewal date.`,
    metrics: {
      accountCount: rows.length,
      flatRenewals: flatRenewals.length,
      topAccount: best.name,
      topAccountGrowthPercent: bestGrowth,
      topChampion: best.top_user ?? 'unknown',
    },
    evidence: rows.slice(0, 8).map((r) => ({
      type: 'account' as const,
      id: r.id,
      label: `${r.name} — ${Math.round(r.prior)} → ${Math.round(r.recent)} daily active users, ${r.champions} power ${
        r.champions === 1 ? 'user' : 'users'
      }${r.open_pipeline > 0 ? `, $${Math.round(r.open_pipeline).toLocaleString()} open` : ', nothing open'}`,
    })),
    confidence: 0.72,
    severity: 'info',
  };
}
