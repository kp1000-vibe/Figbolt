import { defineConfig } from 'drizzle-kit';

// Migrations are authored against the PostgreSQL dialect and are byte-identical
// for the PGlite (local, WASM) and node-postgres (hosted) drivers.
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/nexus' },
  verbose: true,
  strict: true,
});
