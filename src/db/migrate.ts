import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import 'dotenv/config';

/**
 * Migration runner.
 *
 * Three phases, in order:
 *   1. bootstrap.sql   - extensions that later DDL depends on (vector, pg_trgm)
 *   2. drizzle journal - generated, immutable, tracked in __drizzle_migrations
 *   3. drizzle/post/*  - hand-written DDL Drizzle's DSL cannot express
 *                        (generated columns, HNSW/GIN indexes, CHECK constraints)
 *
 * Phase 3 files are idempotent and replayed whenever their content hash
 * changes, tracked in `__nexus_post_migrations`.
 */

const DRIZZLE_DIR = path.resolve(process.cwd(), 'drizzle');

async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

export async function runMigrations(opts: { log?: boolean; dataDir?: string } = {}) {
  const log = (msg: string) => opts.log !== false && console.log(msg);
  const { getHandle } = await import('./client');
  const handle = await getHandle(opts.dataDir);
  const { db, driver } = handle;

  log(`  driver: ${driver}`);

  // ── Phase 1: extensions ──────────────────────────────────────────────────
  const bootstrap = await readFile(path.join(DRIZZLE_DIR, 'bootstrap.sql'), 'utf8');
  for (const stmt of splitStatements(bootstrap)) {
    await db.execute(sql.raw(stmt));
  }
  log('  ✓ extensions');

  // ── Phase 2: journalled migrations ───────────────────────────────────────
  if (driver === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder: DRIZZLE_DIR });
  } else {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as never, { migrationsFolder: DRIZZLE_DIR });
  }
  log('  ✓ schema migrations');

  // ── Phase 3: post-migrations ─────────────────────────────────────────────
  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS __nexus_post_migrations (
      name text PRIMARY KEY,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`),
  );

  const postDir = path.join(DRIZZLE_DIR, 'post');
  const files = (await readdir(postDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const body = await readFile(path.join(postDir, file), 'utf8');
    const hash = await sha256(body);
    const existing = (await db.execute(
      sql`SELECT hash FROM __nexus_post_migrations WHERE name = ${file}`,
    )) as { rows: { hash: string }[] };
    const row = existing.rows[0];
    if (row?.hash === hash) continue;

    for (const stmt of splitStatements(body)) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (err) {
        throw new Error(
          `post-migration ${file} failed on statement:\n${stmt.slice(0, 400)}\n\n${
            (err as Error).message
          }`,
        );
      }
    }
    await db.execute(
      sql`INSERT INTO __nexus_post_migrations (name, hash) VALUES (${file}, ${hash})
          ON CONFLICT (name) DO UPDATE SET hash = ${hash}, applied_at = now()`,
    );
    log(`  ✓ post/${file}`);
  }

  return handle;
}

/**
 * Split on semicolons that terminate a statement, respecting dollar-quoted
 * blocks (`$$ ... $$`, `$expr$ ... $expr$`) and string literals. The post
 * migrations lean on DO blocks, so a naive `split(';')` would shred them.
 */
export function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let dollarTag: string | null = null;

  while (i < sqlText.length) {
    const ch = sqlText[i]!;
    const rest = sqlText.slice(i);

    if (dollarTag) {
      if (rest.startsWith(dollarTag)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === '-' && rest.startsWith('--')) {
        const nl = sqlText.indexOf('\n', i);
        i = nl === -1 ? sqlText.length : nl;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
      } else {
        const tag = /^\$[A-Za-z_]*\$/.exec(rest);
        if (tag) {
          dollarTag = tag[0];
          buf += dollarTag;
          i += dollarTag.length;
          continue;
        }
        if (ch === ';') {
          const trimmed = buf.trim();
          if (trimmed) out.push(trimmed);
          buf = '';
          i += 1;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  // Drizzle's own generated files use `--> statement-breakpoint`; strip leftovers.
  return out.map((s) => s.replace(/-->\s*statement-breakpoint/g, '').trim()).filter(Boolean);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  console.log('▸ Running migrations…');
  runMigrations()
    .then(async (handle) => {
      console.log('✓ Migrations complete.');
      await handle.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error('✗ Migration failed:\n', err);
      process.exit(1);
    });
}
