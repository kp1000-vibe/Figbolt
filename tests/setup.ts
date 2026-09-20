import 'dotenv/config';

// Tests always exercise the offline path: deterministic, no network, no keys.
process.env['AI_PROVIDER'] = 'local';
process.env['EMBEDDING_PROVIDER'] = 'local';
// NODE_ENV is set by Vitest itself and is read-only on the process env type.
process.env['AUTH_SECRET'] ||= 'test-secret-not-used-in-production-000000';
process.env['INTEGRATION_TOKEN_KEY'] ||= Buffer.alloc(32, 7).toString('base64url');
// Force PGlite in-memory rather than the developer's ./.pglite directory.
delete process.env['DATABASE_URL'];
