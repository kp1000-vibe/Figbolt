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

  /**
   * Jev — the decision model that picks which LLM runs each job.
   * Off by default: turning it on sends a description of every AI job to
   * TypeSafe, which is a data-egress decision an operator should make
   * deliberately rather than inherit.
   */
  JEV_ROUTER: z.enum(['on', 'off']).default('off'),
  /** Search Console / Bing Webmaster ownership codes, rendered as meta tags. */
  GOOGLE_SITE_VERIFICATION: optional,
  /** Comma-separated emails allowed to see /admin/site-analytics. Unset: nobody. */
  SITE_ADMIN_EMAILS: optional,
  BING_SITE_VERIFICATION: optional,
  /** api.typesafe.ai key. The SDK and docs both call it TYPESAFE_API_KEY. */
  TYPESAFE_API_KEY: optional,
  /** Opt in to sending the operator's own request text, never customer content. */
  JEV_SEND_CONTENT: bool(false),
  /**
   * Opt in to Jev reading customer content (emails, transcripts) to make a
   * decision directly — triage, scoring — instead of an LLM. Separate from
   * JEV_SEND_CONTENT because it sends other people's words to TypeSafe.
   */
  JEV_CUSTOMER_CONTENT: bool(false),
  /**
   * The models Jev chooses between, comma-separated: `claude-haiku-4-5-20251001,
   * gpt-4.1,gemini-2.5-pro`, or `provider:model` to be explicit. Unset, the
   * catalogue is Claude Haiku, Sonnet and Opus plus OPENAI_MODEL and
   * GOOGLE_MODEL. Either way a model is only offered when its provider's key
   * is set. See src/lib/ai/catalogue.ts.
   */
  JEV_MODELS: optional,
  /**
   * Legacy: extra candidates, as a model ID or a provider name. Kept so
   * existing deployments keep their models; prefer JEV_MODELS.
   */
  MODEL_TIER_TINY: optional,
  MODEL_TIER_EVERYDAY: optional,
  MODEL_TIER_LARGE: optional,
  MODEL_TIER_HARDEST: optional,

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

  /**
   * Calendar writes. `console` is the default and delivers nothing: the
   * meeting is recorded and an .ics is produced, but no event is created in
   * anyone's calendar. A demo workspace putting real events in a stranger's
   * Outlook would be a serious bug, so this has to be turned on deliberately.
   */
  CALENDAR_PROVIDER: z.enum(['console', 'google', 'microsoft']).default('console'),
  GOOGLE_OAUTH_CLIENT_ID: optional,
  GOOGLE_OAUTH_CLIENT_SECRET: optional,
  MICROSOFT_OAUTH_CLIENT_ID: optional,
  MICROSOFT_OAUTH_CLIENT_SECRET: optional,
  MICROSOFT_TENANT_ID: optional,

  /**
   * Speech-to-text for meeting recordings. `none` means no automatic
   * transcription; an uploaded transcript still works.
   */
  TRANSCRIPTION_PROVIDER: z.enum(['none', 'local', 'deepgram', 'openai']).default('none'),
  DEEPGRAM_API_KEY: optional,
  /**
   * A self-hosted Whisper server speaking the OpenAI audio API: whisper.cpp's
   * whisper-server, faster-whisper-server, Speaches or LocalAI all do. Free,
   * open source, and the audio never leaves the machine you run it on.
   */
  WHISPER_BASE_URL: z.string().url().default('http://127.0.0.1:8080/v1'),
  WHISPER_MODEL: z.string().default('whisper-1'),

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
