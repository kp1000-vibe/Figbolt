import { and, desc, eq, sql } from 'drizzle-orm';
import { accounts, productSignalThemes, productSignals } from '@/db/schema';
import { NotFoundError, scope, scoped, type Ctx } from '../context';
import { rawQuery } from '../db-query';

/**
 * Product signals, aggregated.
 *
 * The point of this surface is to let a product team use sales conversations
 * as customer research. So the numbers that matter are not "how many times was
 * SSO mentioned" but "how many distinct accounts, worth how much pipeline" —
 * and every theme keeps the individual quotes so a PM can read the raw asks.
 */

export type ThemeRollup = {
  themeId: string | null;
  name: string;
  category: string;
  status: string;
  accountCount: number;
  enterpriseAccountCount: number;
  mentionCount: number;
  openPipeline: number;
  currentArr: number;
  blockingCount: number;
  lastMentionedAt: string | null;
};

export async function listThemes(ctx: Ctx, category?: string): Promise<ThemeRollup[]> {
  const rows = await rawQuery<{
    theme_id: string | null;
    name: string;
    category: string;
    status: string | null;
    account_count: number;
    enterprise_count: number;
    mention_count: number;
    open_pipeline: number;
    current_arr: number;
    blocking_count: number;
    last_mentioned: string | null;
  }>(
    ctx,
    sql`
      SELECT
        t.id AS theme_id,
        COALESCE(t.name, ps.title) AS name,
        COALESCE(t.category, ps.category) AS category,
        t.status,
        COUNT(DISTINCT ps.account_id)::int AS account_count,
        COUNT(DISTINCT ps.account_id) FILTER (WHERE a.tier = 'enterprise')::int AS enterprise_count,
        COUNT(ps.id)::int AS mention_count,
        COALESCE(SUM(DISTINCT o.value), 0)::float8 AS open_pipeline,
        COALESCE(SUM(DISTINCT a.current_arr), 0)::float8 AS current_arr,
        COUNT(ps.id) FILTER (WHERE ps.urgency = 'blocking')::int AS blocking_count,
        MAX(ps.occurred_at)::text AS last_mentioned
      FROM product_signals ps
      LEFT JOIN product_signal_themes t ON t.id = ps.theme_id
      LEFT JOIN accounts a ON a.id = ps.account_id AND a.deleted_at IS NULL
      LEFT JOIN opportunities o
        ON o.id = ps.opportunity_id AND o.status = 'open' AND o.deleted_at IS NULL
      WHERE ps.workspace_id = ${ctx.workspaceId}
        AND ps.deleted_at IS NULL
        ${category ? sql`AND COALESCE(t.category, ps.category) = ${category}` : sql``}
      GROUP BY t.id, COALESCE(t.name, ps.title), COALESCE(t.category, ps.category), t.status
      ORDER BY account_count DESC, open_pipeline DESC
    `,
  );

  return rows.map((r) => ({
    themeId: r.theme_id,
    name: r.name,
    category: r.category,
    status: r.status ?? 'open',
    accountCount: r.account_count,
    enterpriseAccountCount: r.enterprise_count,
    mentionCount: r.mention_count,
    openPipeline: Number(r.open_pipeline),
    currentArr: Number(r.current_arr),
    blockingCount: r.blocking_count,
    lastMentionedAt: r.last_mentioned,
  }));
}

export async function getThemeDetail(ctx: Ctx, themeId: string) {
  const [theme] = await ctx.db
    .select()
    .from(productSignalThemes)
    .where(and(scope(ctx, productSignalThemes), eq(productSignalThemes.id, themeId)))
    .limit(1);
  if (!theme) throw new NotFoundError('Theme', themeId);

  const mentions = await ctx.db
    .select({
      id: productSignals.id,
      title: productSignals.title,
      detail: productSignals.detail,
      urgency: productSignals.urgency,
      category: productSignals.category,
      sourceType: productSignals.sourceType,
      sourceId: productSignals.sourceId,
      sourceQuote: productSignals.sourceQuote,
      confidence: productSignals.confidence,
      occurredAt: productSignals.occurredAt,
      accountId: productSignals.accountId,
      accountName: accounts.name,
      accountTier: accounts.tier,
      accountArr: accounts.currentArr,
      opportunityId: productSignals.opportunityId,
    })
    .from(productSignals)
    .leftJoin(accounts, eq(accounts.id, productSignals.accountId))
    .where(scoped(ctx, productSignals, eq(productSignals.themeId, themeId)))
    .orderBy(desc(productSignals.occurredAt));

  return { theme, mentions };
}

export async function signalCategoryCounts(ctx: Ctx) {
  return rawQuery<{ category: string; n: number; accounts: number }>(
    ctx,
    sql`
      SELECT category, count(*)::int AS n, count(DISTINCT account_id)::int AS accounts
      FROM product_signals
      WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC
    `,
  );
}

export async function setThemeStatus(
  ctx: Ctx,
  themeId: string,
  status: 'open' | 'planned' | 'in_progress' | 'shipped' | 'declined',
) {
  await ctx.db
    .update(productSignalThemes)
    .set({ status })
    .where(and(scope(ctx, productSignalThemes), eq(productSignalThemes.id, themeId)));
}
