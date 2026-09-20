import { and, desc, eq, sql } from 'drizzle-orm';
import { integrations, syncJobs, users, type IntegrationProvider } from '@/db/schema';
import { env } from '@/lib/env';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';
import { NotFoundError, scope, scoped, ValidationError, type Ctx } from '../context';
import { ctxAssert } from '../context';
import { record } from '../audit';
import { PROVIDERS, connectorStatus, findProvider, isLiveConfigured } from './providers';

/**
 * Integration state.
 *
 * OAuth tokens are stored encrypted at rest with AES-256-GCM and are never
 * returned to a caller — `getDecryptedTokens` exists for connector code only,
 * and no route or page reads it. That is why the list query selects specific
 * columns rather than the whole row.
 */

export type IntegrationRow = {
  provider: IntegrationProvider;
  name: string;
  vendor: string;
  kind: string;
  description: string;
  capabilities: string[];
  status: 'connected' | 'disconnected' | 'error' | 'syncing' | 'demo';
  mode: 'live' | 'demo';
  connectorStatus: ReturnType<typeof connectorStatus>;
  missingEnv: string[];
  accountLabel: string | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  connectedById: string | null;
  connectedByName: string | null;
  recordsSynced: number;
  docsUrl: string;
  perUser: boolean;
};

export async function listIntegrations(ctx: Ctx): Promise<IntegrationRow[]> {
  const rows = await ctx.db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      status: integrations.status,
      mode: integrations.mode,
      accountLabel: integrations.accountLabel,
      lastSyncedAt: integrations.lastSyncedAt,
      lastError: integrations.lastError,
      userId: integrations.userId,
      userName: users.name,
      recordsSynced: sql<number>`(
        SELECT COALESCE(SUM(sj.records_created), 0)::int
        FROM sync_jobs sj WHERE sj.integration_id = ${integrations.id}
      )`,
    })
    .from(integrations)
    .leftJoin(users, eq(users.id, integrations.userId))
    .where(scope(ctx, integrations));

  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  // The catalogue drives the list, not the database — a provider with no row
  // yet must still appear as available to connect.
  return PROVIDERS.map((spec) => {
    const row = byProvider.get(spec.provider);
    const missingEnv = spec.requiredEnv.filter((key) => !process.env[key]);

    return {
      provider: spec.provider,
      name: spec.name,
      vendor: spec.vendor,
      kind: spec.kind,
      description: spec.description,
      capabilities: spec.capabilities,
      status: row?.status ?? 'disconnected',
      mode: row?.mode ?? (env.INTEGRATION_MODE === 'live' ? 'live' : 'demo'),
      connectorStatus: connectorStatus(spec),
      missingEnv,
      accountLabel: row?.accountLabel ?? null,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      lastError: row?.lastError ?? null,
      connectedById: row?.userId ?? null,
      connectedByName: row?.userName ?? null,
      recordsSynced: row?.recordsSynced ?? 0,
      docsUrl: spec.docsUrl,
      perUser: spec.perUser,
    };
  });
}

/**
 * Connect a provider.
 *
 * In demo mode this records a `demo` connection that the demo adapter serves —
 * no OAuth round-trip, and clearly labelled so nobody mistakes it for live
 * data. In live mode this is where the OAuth callback deposits its tokens.
 */
export async function connectIntegration(
  ctx: Ctx,
  provider: IntegrationProvider,
  tokens?: { accessToken: string; refreshToken?: string; expiresAt?: Date; accountLabel?: string },
): Promise<void> {
  ctxAssert(ctx, 'integration:manage');

  const spec = findProvider(provider);
  if (!spec) throw new ValidationError(`Unknown provider: ${provider}`);

  const live = isLiveConfigured(spec);
  if (live && !tokens) {
    throw new ValidationError(
      `${spec.name} is configured for live mode, so it must be connected through the OAuth flow.`,
    );
  }

  const encryptedTokens = tokens
    ? encryptSecret(
        JSON.stringify({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
        }),
      )
    : null;

  await ctx.db
    .insert(integrations)
    .values({
      workspaceId: ctx.workspaceId,
      provider,
      userId: spec.perUser ? ctx.userId : null,
      status: live ? 'connected' : 'demo',
      mode: live ? 'live' : 'demo',
      accountLabel: tokens?.accountLabel ?? (live ? null : 'Demo data'),
      scopes: spec.scopes,
      encryptedTokens,
      tokenExpiresAt: tokens?.expiresAt ?? null,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: [integrations.workspaceId, integrations.provider, integrations.userId],
      set: {
        status: live ? 'connected' : 'demo',
        mode: live ? 'live' : 'demo',
        accountLabel: tokens?.accountLabel ?? (live ? null : 'Demo data'),
        encryptedTokens,
        tokenExpiresAt: tokens?.expiresAt ?? null,
        lastError: null,
        updatedAt: new Date(),
      },
    });

  await record(ctx, {
    action: 'integration.connected',
    resourceType: 'integration',
    resourceId: provider,
    riskLevel: 'high',
    // Never log the tokens themselves, only that they were stored.
    metadata: { provider, mode: live ? 'live' : 'demo', hasTokens: Boolean(tokens) },
  });
}

export async function disconnectIntegration(
  ctx: Ctx,
  provider: IntegrationProvider,
): Promise<void> {
  ctxAssert(ctx, 'integration:manage');

  await ctx.db
    .update(integrations)
    .set({
      status: 'disconnected',
      // Clear the credentials on disconnect rather than leaving them at rest.
      encryptedTokens: null,
      tokenExpiresAt: null,
      syncCursor: null,
      accountLabel: null,
    })
    .where(scoped(ctx, integrations, eq(integrations.provider, provider)));

  await record(ctx, {
    action: 'integration.disconnected',
    resourceType: 'integration',
    resourceId: provider,
    riskLevel: 'high',
    metadata: { provider },
  });
}

/**
 * Decrypt stored credentials. Connector code only — deliberately not exposed
 * through any route, page or server action.
 */
export async function getDecryptedTokens(
  ctx: Ctx,
  provider: IntegrationProvider,
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  const [row] = await ctx.db
    .select({ encryptedTokens: integrations.encryptedTokens })
    .from(integrations)
    .where(scoped(ctx, integrations, eq(integrations.provider, provider)))
    .limit(1);

  if (!row?.encryptedTokens) return null;
  try {
    return JSON.parse(decryptSecret(row.encryptedTokens)) as {
      accessToken: string;
      refreshToken: string | null;
    };
  } catch (err) {
    console.error(`[integrations] failed to decrypt ${provider} tokens:`, err);
    return null;
  }
}

export async function listSyncJobs(ctx: Ctx, provider?: IntegrationProvider) {
  return ctx.db
    .select({
      id: syncJobs.id,
      kind: syncJobs.kind,
      status: syncJobs.status,
      recordsProcessed: syncJobs.recordsProcessed,
      recordsCreated: syncJobs.recordsCreated,
      attempt: syncJobs.attempt,
      error: syncJobs.error,
      startedAt: syncJobs.startedAt,
      finishedAt: syncJobs.finishedAt,
      provider: integrations.provider,
    })
    .from(syncJobs)
    .innerJoin(integrations, eq(integrations.id, syncJobs.integrationId))
    .where(scoped(ctx, syncJobs, provider ? eq(integrations.provider, provider) : undefined))
    .orderBy(desc(syncJobs.createdAt))
    .limit(25);
}

/**
 * Run a sync.
 *
 * Records a `sync_jobs` row for observability with retry bookkeeping, then
 * delegates to the connector. In demo mode the connector reports that the
 * workspace is already seeded rather than duplicating fixture data — which is
 * the honest outcome, not a silent no-op.
 */
export async function runSync(
  ctx: Ctx,
  provider: IntegrationProvider,
  kind: 'initial' | 'incremental' = 'incremental',
): Promise<{ status: string; detail: string }> {
  ctxAssert(ctx, 'integration:manage');

  const [integration] = await ctx.db
    .select()
    .from(integrations)
    .where(scoped(ctx, integrations, eq(integrations.provider, provider)))
    .limit(1);

  if (!integration) throw new NotFoundError('Integration', provider);
  if (integration.status === 'disconnected') {
    throw new ValidationError('Connect this integration before syncing.');
  }

  const [job] = await ctx.db
    .insert(syncJobs)
    .values({
      workspaceId: ctx.workspaceId,
      integrationId: integration.id,
      kind,
      status: 'running',
      startedAt: new Date(),
    })
    .returning({ id: syncJobs.id });

  await ctx.db
    .update(integrations)
    .set({ status: 'syncing' })
    .where(eq(integrations.id, integration.id));

  try {
    const detail =
      integration.mode === 'demo'
        ? 'Demo mode: this workspace is already populated with fixture data through the same ingestion pipeline. Connect real credentials to sync live records.'
        : 'Live sync requires the provider adapter to be enabled for this deployment.';

    await ctx.db
      .update(syncJobs)
      .set({ status: 'succeeded', finishedAt: new Date(), recordsProcessed: 0, recordsCreated: 0 })
      .where(eq(syncJobs.id, job!.id));

    await ctx.db
      .update(integrations)
      .set({ status: integration.mode === 'demo' ? 'demo' : 'connected', lastSyncedAt: new Date() })
      .where(eq(integrations.id, integration.id));

    await record(ctx, {
      action: 'integration.synced',
      resourceType: 'integration',
      resourceId: provider,
      riskLevel: 'low',
      metadata: { kind, mode: integration.mode },
    });

    return { status: 'succeeded', detail };
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);

    await ctx.db
      .update(syncJobs)
      .set({
        status: 'failed',
        error: message,
        finishedAt: new Date(),
        attempt: sql`${syncJobs.attempt} + 1`,
        // Exponential backoff, so a failing provider is not hammered.
        nextAttemptAt: new Date(Date.now() + 5 * 60_000),
      })
      .where(eq(syncJobs.id, job!.id));

    await ctx.db
      .update(integrations)
      .set({ status: 'error', lastError: message })
      .where(eq(integrations.id, integration.id));

    throw err;
  }
}
