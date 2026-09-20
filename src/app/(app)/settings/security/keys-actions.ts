'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ROLES, type Role } from '@/db/schema';
import { requireCtx, ValidationError, ctxAssert } from '@/server/context';
import { AuthorizationError, roleAtLeast } from '@/lib/security/permissions';
import { createApiKey, revokeApiKey } from '@/server/api/auth';
import type { ActionResult } from '@/app/actions';

/**
 * API-key management.
 *
 * The plaintext key is returned exactly once, from `createApiKey`, and is never
 * stored — only its SHA-256 hash is. If the user loses it there is no recovery
 * path by design, which is why the UI makes copying it a deliberate step.
 */

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name.').max(80),
  role: z.enum(ROLES),
  expiresInDays: z.number().int().min(1).max(365).nullable(),
});

export async function createApiKeyAction(
  input: unknown,
): Promise<ActionResult<{ plaintext: string; prefix: string; name: string }>> {
  try {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid key.' };
    }

    const ctx = await requireCtx();
    // Minting a credential that can act on the workspace is an admin action,
    // regardless of which role the key itself will carry.
    ctxAssert(ctx, 'workspace:manage');

    const role: Role = parsed.data.role;
    if (!roleAtLeast(ctx.role, role)) {
      return { ok: false, error: `You cannot create a key with a role above your own (${ctx.role}).` };
    }

    const key = await createApiKey(ctx, {
      name: parsed.data.name,
      role,
      ...(parsed.data.expiresInDays != null ? { expiresInDays: parsed.data.expiresInDays } : {}),
    });

    revalidatePath('/settings/security');
    return {
      ok: true,
      data: { plaintext: key.plaintext, prefix: key.prefix, name: parsed.data.name },
      message: 'Key created. Copy it now — it will not be shown again.',
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[settings] createApiKeyAction failed:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

export async function revokeApiKeyAction(keyId: string): Promise<ActionResult> {
  try {
    const ctx = await requireCtx();
    ctxAssert(ctx, 'workspace:manage');
    await revokeApiKey(ctx, keyId);
    revalidatePath('/settings/security');
    return { ok: true, message: 'Key revoked. Requests using it now fail immediately.' };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[settings] revokeApiKeyAction failed:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}
