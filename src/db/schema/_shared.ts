import { customType, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';

/**
 * Shared column vocabulary.
 *
 * Two invariants hold across the whole schema and are relied on by the
 * repository layer in `src/server/db-scope.ts`:
 *
 *  1. Every workspace-owned row carries a non-null `workspace_id` that
 *     cascades on workspace deletion, and is the leading column of at least
 *     one index.
 *  2. Anything a user can "delete" from the UI is soft-deleted via
 *     `deleted_at`, so AI-derived facts never dangle against missing evidence.
 */

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const rand = customAlphabet(alphabet, 21);

/** Prefixed, sortable-enough, URL-safe identifier: `acc_k3f9...`. */
export function newId(prefix: string): string {
  return `${prefix}_${rand()}`;
}

export const primaryId = (prefix: string) =>
  text('id')
    .primaryKey()
    .$defaultFn(() => newId(prefix));

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
};

/** `tsvector` for lexical search; populated by generated columns in migrations. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/** Millisecond-precision numeric that survives JS `number` round-tripping. */
export const money = customType<{ data: number; driverData: string }>({
  dataType: () => 'numeric(16, 2)',
  fromDriver: (v) => Number(v),
  toDriver: (v) => String(v),
});

export const nowSql = sql`now()`;
