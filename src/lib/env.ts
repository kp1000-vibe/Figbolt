import { z } from 'zod';

/**
 * Validated process configuration.
 *
 * Everything here is server-only apart from the explicitly-prefixed
 * `NEXT_PUBLIC_*` values. Importing this module from a client component is a
 * build error by design — see `src/lib/env.public.ts` for browser-safe config.
 */

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v.toLowerCase() === 'true'));

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: optional,

  AUTH_SECRET: optional,
  AUTH_COOKIE_SECURE: bool(true),

  AI_PROVIDER: z.enum(['anthropic', 'openai', 'google', 'local']).default('local'),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  GOOGLE_API_KEY: optional,
  GOOGLE_MODEL: z.string().default('gemini-2.5-pro'),

  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),

  JOB_RUNNER: z.enum(['inline', 'inngest']).default('inline'),
  INNGEST_EVENT_KEY: optional,
  INNGEST_SIGNING_KEY: optional,

  INTEGRATION_MODE: z.enum(['demo', 'live']).default('demo'),
  INTEGRATION_TOKEN_KEY: optional,

  EMAIL_PROVIDER: z.enum(['console', 'resend', 'ses']).default('console'),
  EMAIL_FROM: z.string().default('Figbolt <hello@figbolt.com>'),
  RESEND_API_KEY: optional,

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: optional,
  S3_REGION: optional,
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,

  SENTRY_DSN: optional,
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Fail loudly rather than silently signing sessions with a known key.
  if (env.NODE_ENV === 'production') {
    if (!env.AUTH_SECRET) {
      throw new Error('AUTH_SECRET is required in production. See .env.example.');
    }
    if (env.INTEGRATION_MODE === 'live' && !env.INTEGRATION_TOKEN_KEY) {
      throw new Error('INTEGRATION_TOKEN_KEY is required when INTEGRATION_MODE=live.');
    }
  }

  return env;
}

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export const env: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    cached ??= load();
    return cached[prop as keyof Env];
  },
});

/** True when the app is running entirely offline against local adapters. */
export function isFullyLocal(): boolean {
  return env.AI_PROVIDER === 'local' && env.INTEGRATION_MODE === 'demo';
}

/** The auth signing key, with a stable dev fallback outside production. */
export function authSecret(): Uint8Array {
  const raw =
    env.AUTH_SECRET ??
    (env.NODE_ENV === 'production'
      ? (() => {
          throw new Error('AUTH_SECRET missing');
        })()
      : 'figbolt-development-only-secret-do-not-use-in-production');
  return new TextEncoder().encode(raw);
}
