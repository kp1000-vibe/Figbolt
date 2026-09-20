import type { SQL } from 'drizzle-orm';
import type { Ctx } from './context';

/**
 * Typed raw-SQL escape hatch.
 *
 * Used only by the analytics report catalogue, where the shape of the result
 * is an aggregate rather than a table row. The statement is always a
 * `sql` template with bound parameters — never string-concatenated input —
 * and always carries an explicit `workspace_id` predicate.
 *
 * Normalises the two drivers: node-postgres and PGlite both return a
 * `{ rows }` envelope, but some Drizzle builds unwrap it to a bare array.
 */
export async function rawQuery<T>(ctx: Ctx, statement: SQL): Promise<T[]> {
  const result = (await ctx.db.execute(statement)) as unknown;
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
