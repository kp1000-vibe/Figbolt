'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCtx, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import { connectIntegration, disconnectIntegration, runSync } from '@/server/integrations/manage';
import { INTEGRATION_PROVIDERS } from '@/db/schema';
import type { ActionResult } from '@/app/actions';

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[integration-action] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

const providerSchema = z.enum(INTEGRATION_PROVIDERS);

export async function connectIntegrationAction(
  provider: string,
): Promise<ActionResult<{ redirectTo?: string }>> {
  return guard(async () => {
    const parsed = providerSchema.safeParse(provider);
    if (!parsed.success) return { ok: false, error: 'Unknown provider.' };

    // When the connector is genuinely configured, connecting means sending the
    // person to the provider's consent screen rather than writing a demo row.
    // The browser follows this; the token exchange happens in the callback.
    const { oauthReady } = await import('@/server/integrations/oauth');
    if (oauthReady(parsed.data)) {
      return {
        ok: true,
        message: `Redirecting to ${parsed.data} to authorise...`,
        data: { redirectTo: `/api/integrations/${parsed.data}/authorize` },
      };
    }

    const ctx = await requireCtx();
    await connectIntegration(ctx, parsed.data);
    revalidatePath('/integrations');
    return { ok: true, message: 'Connected in demo mode. Fixture data flows through the real pipeline.' };
  });
}

export async function disconnectIntegrationAction(provider: string): Promise<ActionResult> {
  return guard(async () => {
    const parsed = providerSchema.safeParse(provider);
    if (!parsed.success) return { ok: false, error: 'Unknown provider.' };

    const ctx = await requireCtx();
    await disconnectIntegration(ctx, parsed.data);
    revalidatePath('/integrations');
    return { ok: true, message: 'Disconnected and stored credentials cleared.' };
  });
}

export async function syncIntegrationAction(provider: string): Promise<ActionResult<{ detail: string }>> {
  return guard<{ detail: string }>(async () => {
    const parsed = providerSchema.safeParse(provider);
    if (!parsed.success) return { ok: false, error: 'Unknown provider.' };

    const ctx = await requireCtx();
    const result = await runSync(ctx, parsed.data, 'incremental');
    revalidatePath('/integrations');
    return { ok: true, data: { detail: result.detail }, message: result.detail };
  });
}
