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
    ];
  },
};

export default config;
