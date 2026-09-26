import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { workspaces } from './schema';
import { eq } from 'drizzle-orm';

/**
 * Re-anchor the workspace to the latest timestamps, then recompute everything
 * derived from them.
 *
 * Why this exists: the engine reads time relatively — "no contact in 17 days",
 * "usage fell versus the previous 30 days", "closing this quarter". Seeded and
 * imported data carries fixed timestamps, so every day that passes drags the
 * whole workspace further into the past until the deal that was closing next
 * week closed two months ago and every health score is wrong.
 *
 * The fix is a single shift, not a rewrite: find how far behind the newest
 * interaction is, move *every* timestamp forward by exactly that delta, and
 * recompute. Shifting uniformly is what preserves the data's meaning — the
 * 17-day silence stays 17 days, the 39-day stage age stays 39 days, and the
 * relative structure the insights depend on is untouched.
 *
 *   npm run db:refresh
 *
 * Idempotent: run it twice and the second run shifts by zero.
 */

/**
 * Every timestamp column that represents when something *happened*.
 *
 * Deliberately excludes `created_at` / `updated_at` bookkeeping on derived
 * rows, and excludes the learning corpus entirely — an eval case's age is
 * real history and must not be rewritten to look fresh.
 */
const SHIFTED: { table: string; columns: string[] }[] = [
  { table: 'accounts', columns: ['created_at', 'last_interaction_at', 'memory_updated_at'] },
  { table: 'contacts', columns: ['created_at', 'last_interaction_at'] },
  {
    table: 'opportunities',
    columns: ['created_at', 'closed_at', 'expected_close_date', 'last_interaction_at', 'stage_entered_at', 'memory_updated_at'],
  },
  { table: 'emails', columns: ['sent_at', 'created_at'] },
  { table: 'meetings', columns: ['starts_at', 'ends_at', 'created_at'] },
  { table: 'transcripts', columns: ['created_at'] },
  { table: 'notes', columns: ['created_at', 'occurred_at'] },
  { table: 'tasks', columns: ['due_at', 'completed_at', 'created_at'] },
  { table: 'commitments', columns: ['due_at', 'fulfilled_at', 'occurred_at', 'created_at'] },
  { table: 'objections', columns: ['occurred_at', 'resolved_at', 'created_at'] },
  { table: 'product_signals', columns: ['occurred_at', 'created_at'] },
  { table: 'memory_facts', columns: ['valid_from', 'valid_until', 'created_at'] },
  { table: 'crm_events', columns: ['occurred_at', 'created_at'] },
  { table: 'activities', columns: ['occurred_at', 'created_at'] },
  { table: 'usage_daily', columns: ['day', 'created_at'] },
  { table: 'support_tickets', columns: ['opened_at', 'resolved_at', 'created_at'] },
  { table: 'notifications', columns: ['created_at', 'snoozed_until'] },
  { table: 'insights', columns: ['computed_at', 'created_at'] },
];

/** The newest real interaction; the shift is measured against this. */
const ANCHOR_SQL = sql`
  SELECT max(t) AS newest FROM (
    SELECT max(sent_at)   AS t FROM emails
    UNION ALL SELECT max(starts_at)  FROM meetings
    UNION ALL SELECT max(occurred_at) FROM activities
    UNION ALL SELECT max(opened_at)  FROM support_tickets
    UNION ALL SELECT max(day)        FROM usage_daily
  ) s
`;

export async function refreshTimestamps(opts: { log?: boolean } = {}): Promise<{
  shiftedDays: number;
  tables: number;
  rows: number;
}> {
  const log = (m: string) => opts.log !== false && console.log(m);
  const { getHandle } = await import('./client');
  const handle = await getHandle();
  const db = handle.db;

  const anchorRes = (await db.execute(ANCHOR_SQL)) as unknown as {
    rows: { newest: Date | string | null }[];
  };
  const newestRaw = anchorRes.rows?.[0]?.newest ?? null;
  if (!newestRaw) {
    log('  no dated interactions found — nothing to re-anchor');
    return { shiftedDays: 0, tables: 0, rows: 0 };
  }

  const newest = new Date(newestRaw);
  // Land the newest interaction a few hours back rather than exactly now, so
  // "today" still has room and nothing sits in the future.
  const target = new Date(Date.now() - 6 * 3600_000);
  const deltaMs = target.getTime() - newest.getTime();
  const shiftedDays = Math.round(deltaMs / 86_400_000);

  if (Math.abs(deltaMs) < 12 * 3600_000) {
    log(`  already current (newest interaction ${hours(deltaMs)}h from target) — no shift`);
    return { shiftedDays: 0, tables: 0, rows: 0 };
  }

  log(`  shifting every timestamp forward by ${shiftedDays} days`);

  let rows = 0;
  let tables = 0;
  for (const { table, columns } of SHIFTED) {
    const present = await existingColumns(db, table, columns);
    if (present.length === 0) continue;

    /**
     * A single UPDATE cannot shift a column that participates in a unique
     * index: Postgres updates rows in an arbitrary order, so a row that has
     * already moved can land on a day a row that has not moved still holds,
     * and the statement aborts halfway. `usage_daily` is keyed on
     * (workspace_id, account_id, contact_id, day) and hits this every time.
     *
     * The fix is to hop via a far-future offset. No intermediate value can
     * collide with a real one, so both statements are collision-free.
     */
    const guarded = await uniqueDateColumns(db, table, present);

    for (const column of present) {
      if (guarded.has(column)) {
        await db.execute(
          sql.raw(`UPDATE ${table} SET ${column} = ${column} + interval '${OFFSET_DAYS} days'`),
        );
        const back = OFFSET_DAYS - shiftedDays;
        const res = (await db.execute(
          sql.raw(`UPDATE ${table} SET ${column} = ${column} - interval '${back} days'`),
        )) as unknown as { rowCount?: number };
        rows += res?.rowCount ?? 0;
      } else {
        const res = (await db.execute(
          sql.raw(
            `UPDATE ${table} SET ${column} = ${column} + interval '${shiftedDays} days'`,
          ),
        )) as unknown as { rowCount?: number };
        rows += res?.rowCount ?? 0;
      }
    }
    tables++;
  }

  log(`  ✓ ${tables} tables re-anchored`);
  await handle.close();
  return { shiftedDays, tables, rows };
}

/** Far enough that no shifted value can collide with a real one. */
const OFFSET_DAYS = 100_000;

/**
 * Which of these columns sit inside a unique index, and therefore need the
 * two-hop shift. Read from the catalogue rather than hardcoded, so a new
 * unique constraint cannot silently reintroduce the collision.
 */
async function uniqueDateColumns(
  db: Awaited<ReturnType<typeof import('./client').getDb>>,
  table: string,
  columns: string[],
): Promise<Set<string>> {
  const res = (await db.execute(sql`
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE c.relname = ${table} AND i.indisunique
  `)) as unknown as { rows: { column_name: string }[] };

  const unique = new Set((res.rows ?? []).map((r) => r.column_name));
  return new Set(columns.filter((c) => unique.has(c)));
}

async function existingColumns(
  db: Awaited<ReturnType<typeof import('./client').getDb>>,
  table: string,
  wanted: string[],
): Promise<string[]> {
  const res = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `)) as unknown as { rows: { column_name: string }[] };
  const have = new Set((res.rows ?? []).map((r) => r.column_name));
  return wanted.filter((c) => have.has(c));
}

function hours(ms: number): string {
  return (Math.abs(ms) / 3600_000).toFixed(1);
}

/**
 * The full sequence: re-anchor, then rebuild everything that reads time.
 *
 * Order matters. Summaries and health quote day counts, insights compare
 * 30-day windows, and the inbox is derived from all of it — so nothing may be
 * recomputed until the shift has landed.
 */
async function main() {
  console.log('▸ Refreshing to the latest timestamps…\n');
  const started = Date.now();

  const shift = await refreshTimestamps();

  // Re-open after the shift so the recompute sees the moved rows.
  const { getHandle } = await import('./client');
  const handle = await getHandle();
  const { systemCtx } = await import('@/server/context');
  const { accounts, opportunities, contacts } = await import('./schema');
  const { isNull } = await import('drizzle-orm');

  const [workspace] = await handle.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.isDemo, true))
    .limit(1);

  if (!workspace) {
    console.log('  no demo workspace to recompute');
    await handle.close();
    return;
  }

  const ctx = await systemCtx(workspace.id, 'Timestamp refresh');

  const { refreshAccountMemory, refreshOpportunityMemory, refreshContactMemory } = await import(
    '@/server/memory/summarize'
  );
  const { computeInsights } = await import('@/server/intelligence/insights');
  const { rebuildInbox } = await import('@/server/inbox');

  const accountRows = await handle.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(isNull(accounts.deletedAt));
  process.stdout.write('  … rebuilding customer memory');
  for (const [i, a] of accountRows.entries()) {
    await refreshAccountMemory(ctx, a.id);
    process.stdout.write(`\r  … rebuilding customer memory (${i + 1}/${accountRows.length})`);
  }

  const oppRows = await handle.db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(isNull(opportunities.deletedAt));
  for (const o of oppRows) await refreshOpportunityMemory(ctx, o.id);

  const contactRows = await handle.db
    .select({ id: contacts.id })
    .from(contacts)
    .where(isNull(contacts.deletedAt));
  for (const c of contactRows.slice(0, 60)) await refreshContactMemory(ctx, c.id);

  console.log(
    `\r  ✓ memory rebuilt for ${accountRows.length} accounts, ${oppRows.length} deals`,
  );

  const insights = await computeInsights(ctx);
  console.log(`  ✓ ${insights.length} insights recomputed`);

  const inbox = await rebuildInbox(ctx);
  console.log(`  ✓ ${inbox} inbox items rebuilt`);

  console.log(
    `\n✓ Refreshed in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (shift.shiftedDays ? ` (shifted +${shift.shiftedDays}d)` : ' (no shift needed)'),
  );

  await handle.close();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('db/refresh');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('\n✗ Refresh failed:\n', err);
    process.exit(1);
  });
}
