import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // PGlite ships a WASM Postgres build and `pg` uses native-ish sockets; neither
  // may be bundled by Turbopack/webpack — they must be required at runtime.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    'pg',
  ],
  typedRoutes: false,
  experimental: {
    // Server Actions carry CRM mutations; keep the payload ceiling tight.
    serverActions: { bodySizeLimit: '4mb' },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // The service worker must never be served stale: a cached copy would
        // keep running the old caching rules after a fix ships. The CSP
        // limits it to same-origin scripts.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default config;
