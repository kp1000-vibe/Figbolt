'use server';

import { revalidatePath } from 'next/cache';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import { requireCtx } from '@/server/context';

export type CallActionState = { ok?: boolean; message?: string };

/**
 * Place a voice-agent call from the contact page. It goes through the same
 * typed tool an agent would use, so every rule (consent, disclosure, calling
 * hours, do-not-call) applies identically. Clicking "Place call" after seeing
 * the exact opening line is the person's approval.
 */
export async function placeCallAction(_prev: CallActionState, formData: FormData): Promise<CallActionState> {
  const ctx = await requireCtx();
  await ensureToolsLoaded();

  const contactId = String(formData.get('contactId') ?? '');
  const talkingPoints = String(formData.get('talkingPoints') ?? '')
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length >= 2)
    .slice(0, 8);

  const outcome = await dispatchTool(
    ctx,
    'place_call',
    {
      contactId,
      purpose: String(formData.get('purpose') ?? '').trim(),
      talkingPoints,
      maxMinutes: Number(formData.get('maxMinutes') ?? 5),
      recordCall: formData.get('recordCall') === 'on',
      consentConfirmed: formData.get('consentConfirmed') === 'on',
    },
    { directUserAction: true },
  );

  revalidatePath(`/contacts/${contactId}`);
  if (outcome.status === 'ok') return { ok: true, message: outcome.result.summary };
  if (outcome.status === 'needs_approval') return { ok: true, message: 'Sent for approval.' };
  return { ok: false, message: outcome.error };
}
