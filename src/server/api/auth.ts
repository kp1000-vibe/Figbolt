import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { apiKeys, users, workspaceMembers, workspaces, type Role } from '@/db/schema';
import { randomToken, safeEqual, sha256 } from '@/lib/security/crypto';
import { permissionsFor, roleAtLeast, type Permission } from '@/lib/security/permissions';
import { record } from '../audit';
import { systemCtx, type Ctx } from '../context';
import { checkRateLimit } from '../rate-limit';

/**
 * API-key authentication.
 *
 * This is the door other agents come through, so it is held to the same
 * standard as the human session path:
 *
 *  - only a SHA-256 hash is stored; the plaintext is shown once at creation
 *  - a key's role is capped by the role of the user who minted it, re-resolved
 *    on every request — revoking that person's access disables their keys
 *  - every authenticated request is rate limited per key
 *  - the resulting `Ctx` is identical in shape to a session `Ctx`, so every
 *    service and tool applies the same scope and permission checks
 */

const PREFIX = 'nxk';

export type ApiKeyContext = Ctx & {
  keyId: string;
  keyName: string;
};

export type AuthFailure = {
  status: 401 | 403 | 429;
  error: string;
};

/**
 * Mint a key. Returns the plaintext exactly once — it is never recoverable
 * afterwards, which is the point.
 */
export async function createApiKey(
  ctx: Ctx,
  input: { name: string; role: Role; expiresInDays?: number },
): Promise<{ id: string; plaintext: string; prefix: string }> {
  // A key may never exceed the authority of whoever created it.
  if (!roleAtLeast(ctx.role, input.role)) {
    throw new Error(`You cannot create a key with a role above your own (${ctx.role}).`);
  }

  const secret = randomToken(32);
  const plaintext = `${PREFIX}_${secret}`;
  const prefix = plaintext.slice(0, 12);

  const [row] = await ctx.db
    .insert(apiKeys)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      prefix,
      tokenHash: sha256(plaintext),
      role: input.role,
      createdById: ctx.userId,
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null,
    })
    .returning({ id: apiKeys.id });

  await record(ctx, {
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: row!.id,
    riskLevel: 'high',
    metadata: { name: input.name, role: input.role, prefix },
  });

  return { id: row!.id, plaintext, prefix };
}

export async function revokeApiKey(ctx: Ctx, keyId: string): Promise<void> {
  await ctx.db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.workspaceId, ctx.workspaceId), eq(apiKeys.id, keyId)));

  await record(ctx, {
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: keyId,
    riskLevel: 'high',
  });
}

export async function listApiKeys(ctx: Ctx) {
  return ctx.db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      role: apiKeys.role,
      lastUsedAt: apiKeys.lastUsedAt,
      useCount: apiKeys.useCount,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
      createdByName: users.name,
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdById))
    .where(eq(apiKeys.workspaceId, ctx.workspaceId))
    .orderBy(apiKeys.createdAt);
}

/**
 * Authenticate a request.
 *
 * Accepts `Authorization: Bearer nxk_…` or `X-Api-Key: nxk_…`. Returns a `Ctx`
 * on success so the caller can hand it straight to any service.
 */
export async function authenticateRequest(
  request: Request,
): Promise<{ ctx: ApiKeyContext } | { failure: AuthFailure }> {
  const header =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    request.headers.get('x-api-key') ??
    '';

  const token = header.trim();
  if (!token.startsWith(`${PREFIX}_`)) {
    return {
      failure: {
        status: 401,
        error: `Missing or malformed API key. Send "Authorization: Bearer ${PREFIX}_…".`,
      },
    };
  }

  const db = await getDb();
  const hash = sha256(token);

  const [row] = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      tokenHash: apiKeys.tokenHash,
      workspaceId: apiKeys.workspaceId,
      role: apiKeys.role,
      createdById: apiKeys.createdById,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      workspaceName: workspaces.name,
      workspaceDeletedAt: workspaces.deletedAt,
    })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
    .where(eq(apiKeys.tokenHash, hash))
    .limit(1);

  // Constant-time compare even though the lookup was by hash — belt and braces
  // against a future change that looks up by prefix.
  if (!row || !safeEqual(row.tokenHash, hash)) {
    return { failure: { status: 401, error: 'Invalid API key.' } };
  }
  if (row.revokedAt) return { failure: { status: 401, error: 'This API key was revoked.' } };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { failure: { status: 401, error: 'This API key has expired.' } };
  }
  if (row.workspaceDeletedAt) {
    return { failure: { status: 401, error: 'That workspace no longer exists.' } };
  }

  const limit = await checkRateLimit(`api:${row.id}`, 600, 60);
  if (!limit.allowed) {
    return { failure: { status: 429, error: 'Rate limit exceeded: 600 requests per minute.' } };
  }

  /**
   * Clamp to the creator's *current* role. A key minted by an admin who has
   * since been demoted to member drops to member on the next request, with no
   * separate revocation step.
   */
  let effectiveRole: Role = row.role;
  if (row.createdById) {
    const [membership] = await db
      .select({ role: workspaceMembers.role, status: workspaceMembers.status })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, row.workspaceId),
          eq(workspaceMembers.userId, row.createdById),
        ),
      )
      .limit(1);

    if (!membership || membership.status !== 'active') {
      return {
        failure: {
          status: 403,
          error: 'The user who created this key no longer has access to the workspace.',
        },
      };
    }
    if (!roleAtLeast(membership.role, row.role)) effectiveRole = membership.role;
  }

  // Usage counters are best-effort; a failed write must not reject the request.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date(), useCount: sql`${apiKeys.useCount} + 1` })
    .where(eq(apiKeys.id, row.id))
    .catch((err: unknown) => console.error('[api] failed to record key usage:', err));

  const base = await systemCtx(row.workspaceId, `API key: ${row.name}`);

  return {
    ctx: {
      ...base,
      role: effectiveRole,
      userId: row.createdById,
      actor: { type: 'integration', id: row.id, label: `API key: ${row.name}` },
      keyId: row.id,
      keyName: row.name,
    },
  };
}

/** Permissions the authenticated key actually holds. */
export function keyPermissions(ctx: ApiKeyContext): readonly Permission[] {
  return permissionsFor(ctx.role);
}
