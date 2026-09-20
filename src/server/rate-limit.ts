import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * Fixed-window rate limiter, backed by the database.
 *
 * Chosen over an in-memory counter because the limits that matter here —
 * login attempts, agent runs, AI questions — must hold across every server
 * instance and survive a restart. An in-process map would reset the moment a
 * container recycled, which is precisely when an attacker benefits.
 *
 * A single UPSERT does the whole thing atomically: the window resets inside the
 * `CASE`, so there is no read-then-write race between concurrent requests.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
};

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const db = await getDb();

  try {
    const result = (await db.execute(sql`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (${key}, 1, now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < now() - (${windowSeconds} || ' seconds')::interval
          THEN 1
          ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - (${windowSeconds} || ' seconds')::interval
          THEN now()
          ELSE rate_limits.window_start
        END
      RETURNING count, window_start
    `)) as unknown as { rows: { count: number; window_start: string | Date }[] };

    const row = result.rows[0];
    if (!row) return { allowed: true, remaining: limit - 1, resetAt: new Date() };

    const windowStart = row.window_start instanceof Date ? row.window_start : new Date(row.window_start);
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      resetAt: new Date(windowStart.getTime() + windowSeconds * 1000),
    };
  } catch (err) {
    // Fail open rather than locking everyone out of the product if the limiter
    // table is unavailable. Logged loudly so it is not silently degraded.
    console.error('[rate-limit] check failed, allowing request:', err);
    return { allowed: true, remaining: limit, resetAt: new Date() };
  }
}

/** Housekeeping: drop windows that can no longer affect any decision. */
export async function pruneRateLimits(olderThanSeconds = 86_400): Promise<void> {
  const db = await getDb();
  await db.execute(
    sql`DELETE FROM rate_limits WHERE window_start < now() - (${olderThanSeconds} || ' seconds')::interval`,
  );
}
