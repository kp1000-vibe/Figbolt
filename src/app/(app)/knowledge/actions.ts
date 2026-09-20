'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCtx, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import { deleteKnowledge, saveKnowledge } from '@/server/knowledge';
import type { ActionResult } from '@/app/actions';

async function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[knowledge-action] unhandled error:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}

const schema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(3).max(200),
  category: z.enum([
    'product', 'pricing', 'security', 'playbook',
    'case_study', 'battlecard', 'methodology', 'onboarding', 'other',
  ]),
  content: z.string().trim().min(40, 'Add some content — agents cite passages, not titles.'),
  tags: z.array(z.string().trim().max(40)).max(12).default([]),
});

export async function saveKnowledgeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'That document is not valid.' };
    }
    const ctx = await requireCtx();
    const id = await saveKnowledge(ctx, parsed.data);

    revalidatePath('/knowledge');
    revalidatePath(`/knowledge/${id}`);
    return {
      ok: true,
      data: { id },
      message: parsed.data.id ? 'Document updated and re-indexed.' : 'Document added and indexed.',
    };
  });
}

export async function deleteKnowledgeAction(documentId: string): Promise<ActionResult> {
  return guard(async () => {
    const ctx = await requireCtx();
    await deleteKnowledge(ctx, documentId);
    revalidatePath('/knowledge');
    return { ok: true, message: 'Document deleted and removed from the index.' };
  });
}
