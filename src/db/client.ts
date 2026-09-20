import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { env } from '@/lib/env';

/**
 * One Drizzle instance, two drivers.
 *
 * - No `DATABASE_URL`  -> PGlite: real PostgreSQL 18 compiled to WASM, running
 *   in this process and persisting to `./.pglite`. Zero install, and `pgvector`
 *   plus full-text search behave exactly as they do on a server.
 * - `DATABASE_URL` set -> node-postgres pool against a hosted database.
 *
 * The migrations, the SQL and the query builder are identical across both, so
 * "works locally" and "works in production" mean the same thing here.
 */

/**
 * Both drivers produce a `PgDatabase` that differs only in its result HKT.
 * Naming that common supertype — rather than a union of the two concrete types
 * — keeps Drizzle's builder overloads (`.returning()`, `.onConflictDoUpdate()`)
 * resolvable at every call site.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

type Handle = {
  db: Database;
  driver: 'pglite' | 'node-postgres';
  /** Present only for PGlite; used by migrate/reset scripts and tests. */
  close: () => Promise<void>;
};

// Next.js dev-mode module reloading would otherwise open a new WASM Postgres
// (and a new connection pool) on every hot reload.
const globalRef = globalThis as unknown as { __nexusDb?: Promise<Handle> };

async function createPglite(dataDir: string | undefined): Promise<Handle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');

  const client = await PGlite.create({
    dataDir: dataDir ?? '.pglite',
    extensions: { vector, pg_trgm },
  });

  const db = drizzlePglite(client, { schema });
  return {
    db,
    driver: 'pglite',
    close: () => client.close(),
  };
}

async function createNodePg(url: string): Promise<Handle> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    // Fail fast rather than hanging a request behind an unreachable database.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: url.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
  });
  const db = drizzleNode(pool, { schema });
  return { db, driver: 'node-postgres', close: () => pool.end() };
}

export function getHandle(dataDirOverride?: string): Promise<Handle> {
  if (!globalRef.__nexusDb) {
    const url = env.DATABASE_URL;
    globalRef.__nexusDb = url ? createNodePg(url) : createPglite(dataDirOverride);
  }
  return globalRef.__nexusDb;
}

/** Resolve the shared Drizzle instance. */
export async function getDb(): Promise<Database> {
  return (await getHandle()).db;
}

export async function getDriver(): Promise<'pglite' | 'node-postgres'> {
  return (await getHandle()).driver;
}

export async function closeDb(): Promise<void> {
  const existing = globalRef.__nexusDb;
  if (!existing) return;
  globalRef.__nexusDb = undefined;
  await (await existing).close();
}

/**
 * Build an isolated in-memory database for tests. Never touches `./.pglite`
 * and is not cached on `globalThis`, so suites cannot leak state into each other.
 */
export async function createTestDb(): Promise<Handle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const client = await PGlite.create({ extensions: { vector, pg_trgm } });
  return {
    db: drizzlePglite(client, { schema }),
    driver: 'pglite',
    close: () => client.close(),
  };
}

export { schema };
