'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCtx, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import type { ActionResult } from '@/app/actions';

/**
 * Promote a scored prospect into the CRM.
 *
 * Three separate tool dispatches rather than one bespoke transaction, because
 * each has its own risk class and audit entry: creating the company, creating
 * the contact, and saving the outreach draft. Nothing here sends anything —
 * the email lands in the outbox as a draft and still needs the normal
 * human-approved send.
 */

const schema = z.object({
  name: z.string().min(2).max(200),
  domain: z.string().max(200).nullable(),
  industry: z.string().max(120).nullable(),
  employeeCount: z.number().int().min(0).max(10_000_000).nullable(),
  description: z.string().max(2000),
  whyThisAccount: z.string().max(2000),
  contact: z
    .object({
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(80),
      title: z.string().max(140),
      email: z.string().max(200).nullable(),
    })
    .nullable(),
  emailDraft: z.object({ subject: z.string().min(1).max(300), body: z.string().min(10).max(20_000) }),
});

export async function addProspectAction(
  input: unknown,
): Promise<ActionResult<{ accountId: string; drafted: boolean; summary: string }>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid prospect.' };
    }
    const p = parsed.data;

    const ctx = await requireCtx();
    await ensureToolsLoaded();

    const accountOutcome = await dispatchTool(
      ctx,
      'create_account',
      {
        name: p.name,
        ...(p.domain ? { domain: p.domain } : {}),
        ...(p.industry ? { industry: p.industry } : {}),
        ...(p.employeeCount != null ? { employeeCount: p.employeeCount } : {}),
        // The scoring rationale is stored on the record, so six weeks later
        // someone can still see why this name entered the pipeline.
        description: `${p.description}\n\nWhy prospected: ${p.whyThisAccount}`.slice(0, 2000),
      },
      { rationale: 'Added from Prospecting as a lookalike of closed-won accounts.', directUserAction: true },
    );

    if (accountOutcome.status === 'error') return { ok: false, error: accountOutcome.error };
    if (accountOutcome.status === 'needs_approval') {
      revalidatePath('/inbox');
      return {
        ok: true,
        data: { accountId: '', drafted: false, summary: accountOutcome.title },
        message: 'Queued for approval — the account has not been created yet.',
      };
    }

    const accountId = String((accountOutcome.result.data as { id?: string } | undefined)?.id ?? '');

    let contactId: string | null = null;
    if (p.contact) {
      const contactOutcome = await dispatchTool(
        ctx,
        'create_contact',
        {
          firstName: p.contact.firstName,
          lastName: p.contact.lastName,
          title: p.contact.title,
          ...(p.contact.email ? { email: p.contact.email } : {}),
          ...(accountId ? { accountId } : {}),
        },
        { rationale: 'Primary contact for a prospected account.', directUserAction: true },
      );
      if (contactOutcome.status === 'ok') {
        contactId = String((contactOutcome.result.data as { id?: string } | undefined)?.id ?? '') || null;
      }
    }

    // Without an address there is nobody to draft to; the account still lands
    // in the CRM, and the UI says the draft was skipped rather than implying
    // an email is waiting.
    let drafted = false;
    if (p.contact?.email) {
      const draftOutcome = await dispatchTool(
        ctx,
        'draft_email',
        {
          to: [p.contact.email],
          subject: p.emailDraft.subject,
          body: p.emailDraft.body,
          ...(accountId ? { accountId } : {}),
          ...(contactId ? { contactId } : {}),
        },
        { rationale: 'First-touch outreach drafted from the prospecting angle.', directUserAction: true },
      );
      drafted = draftOutcome.status === 'ok';
    }

    revalidatePath('/prospecting');
    revalidatePath('/accounts');
    revalidatePath('/inbox');

    return {
      ok: true,
      data: {
        accountId,
        drafted,
        summary: drafted
          ? `Added ${p.name} and saved a draft — review before sending.`
          : `Added ${p.name}. No email address, so no draft was created.`,
      },
      message: drafted ? 'Added and drafted.' : 'Added to CRM.',
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof AuthorizationError) {
      return { ok: false, error: err.message };
    }
    console.error('[prospecting] addProspectAction failed:', err);
    return { ok: false, error: 'Something went wrong. The error has been logged.' };
  }
}
