import { and, desc, eq } from 'drizzle-orm';
import { contacts, users, voiceCalls, workspaces, type VoiceCallStatus } from '@/db/schema';
import { publicOrigin } from '@/lib/app-url';
import { randomToken, safeEqual, sha256 } from '@/lib/security/crypto';
import { getDb } from '@/db/client';
import { scope, systemCtx, ValidationError, type Ctx } from '../context';
import { record } from '../audit';
import { intakeTranscript } from '../meetings/intake';
import { getVoiceProvider, type CallReport, type VoiceProvider } from './provider';
import { openingLine, systemPrompt, toE164, withinCallingHours } from '@/lib/voice/script';

export { E164, openingLine, systemPrompt, toE164, withinCallingHours } from '@/lib/voice/script';

/**
 * Outbound voice-agent calls.
 *
 * A voice agent phoning a customer is the highest-stakes thing this product
 * does: it speaks for the business, in real time, with no chance to review
 * each sentence. So the rules are enforced here, in code, before a number is
 * ever dialled:
 *
 *   1. A person approves every call, seeing the exact opening line.
 *   2. The agent says it is an AI in its first sentence — always.
 *   3. The approver confirms the person agreed to be called (AI voice calls
 *      are regulated; in the US the FCC treats AI voices as "artificial"
 *      under the TCPA, which requires prior consent).
 *   4. Calls go only to existing contacts, at an E.164 number on file.
 *   5. Not outside 8am-9pm in the contact's own time zone, when known.
 *   6. "Stop calling me" is honoured permanently for that number.
 *   7. Recording only when the approver says the person agreed to it.
 *   8. The agent cannot agree to prices, discounts, contracts or deadlines.
 *
 * After the call, the transcript is fetched from the provider — never taken
 * from the webhook body — and flows into the same meeting pipeline as any
 * other conversation, where it is evidence, not instructions.
 */

const DO_NOT_CALL = /\b(stop calling|don'?t call|do not call|never call|remove me|take me off|no more calls|unsubscribe)\b/i;

/** True if anything the customer said asks us to stop calling. */
export function askedNotToBeCalled(report: Pick<CallReport, 'turns'>): boolean {
  return report.turns.some((t) => t.role === 'customer' && DO_NOT_CALL.test(t.text));
}

export async function isDoNotCall(ctx: Ctx, toNumber: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: voiceCalls.id })
    .from(voiceCalls)
    .where(and(scope(ctx, voiceCalls), eq(voiceCalls.toNumber, toNumber), eq(voiceCalls.outcome, 'do_not_call')))
    .limit(1);
  return Boolean(row);
}

/* ── Placing a call ───────────────────────────────────────────────────────── */

export type PlaceCallInput = {
  contactId: string;
  purpose: string;
  talkingPoints: string[];
  maxMinutes: number;
  recordCall: boolean;
  consentConfirmed: boolean;
  opportunityId?: string;
};

export type CallPlan = {
  contact: { id: string; name: string; firstName: string | null; accountId: string | null; email: string | null };
  toNumber: string;
  businessName: string;
  callerName: string | null;
  firstMessage: string;
  prompt: string;
  callingHours: boolean | null;
};

/** Everything about the call that can be decided before dialling. Throws on any rule. */
export async function planCall(ctx: Ctx, input: PlaceCallInput): Promise<CallPlan> {
  if (input.consentConfirmed !== true) {
    throw new ValidationError(
      'Confirm that this person agreed to receive calls from you. AI voice calls need prior consent.',
    );
  }

  const [contact] = await ctx.db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      email: contacts.email,
      timezone: contacts.timezone,
      accountId: contacts.accountId,
    })
    .from(contacts)
    .where(and(scope(ctx, contacts), eq(contacts.id, input.contactId)))
    .limit(1);
  if (!contact) throw new ValidationError('Calls can only be made to an existing contact.');

  const toNumber = toE164(contact.phone);
  if (!toNumber) {
    throw new ValidationError(
      'This contact has no phone number in international format (e.g. +14155550123). Add one first.',
    );
  }
  if (await isDoNotCall(ctx, toNumber)) {
    throw new ValidationError('This person asked not to be called again. The number is blocked for good.');
  }

  const callingHours = withinCallingHours(contact.timezone);
  if (callingHours === false) {
    throw new ValidationError(`It is outside 8am-9pm for this contact (${contact.timezone}). Try again in their daytime.`);
  }

  const [ws] = await ctx.db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  const caller = ctx.userId
    ? (await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1))[0]
    : undefined;

  const businessName = ws?.name ?? 'our team';
  const callerName = caller?.name ?? null;
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'the contact';

  return {
    contact: {
      id: contact.id,
      name,
      firstName: contact.firstName ?? null,
      accountId: contact.accountId ?? null,
      email: contact.email ?? null,
    },
    toNumber,
    businessName,
    callerName,
    callingHours,
    firstMessage: openingLine({
      callerName,
      businessName,
      contactFirstName: contact.firstName ?? null,
      purpose: input.purpose,
      recordCall: input.recordCall,
    }),
    prompt: systemPrompt({
      businessName,
      callerName,
      contactName: name,
      purpose: input.purpose,
      talkingPoints: input.talkingPoints,
      maxMinutes: input.maxMinutes,
    }),
  };
}

export async function placeCall(
  ctx: Ctx,
  input: PlaceCallInput,
  provider: VoiceProvider = getVoiceProvider(),
): Promise<{ callId: string; status: VoiceCallStatus; placed: boolean }> {
  const plan = await planCall(ctx, input);

  // The token travels in the webhook URL; only its hash is stored, so a
  // database read cannot be turned into a forged webhook.
  const token = randomToken(24);
  const [call] = await ctx.db
    .insert(voiceCalls)
    .values({
      workspaceId: ctx.workspaceId,
      contactId: plan.contact.id,
      accountId: plan.contact.accountId,
      opportunityId: input.opportunityId ?? null,
      toNumber: plan.toNumber,
      purpose: input.purpose,
      talkingPoints: input.talkingPoints,
      openingLine: plan.firstMessage,
      recordCall: input.recordCall,
      maxMinutes: input.maxMinutes,
      consentConfirmedById: ctx.userId,
      consentConfirmedAt: new Date(),
      status: 'placing',
      provider: provider.name,
      webhookTokenHash: sha256(token),
      createdById: ctx.userId,
      createdByAgentId: ctx.actor.type === 'agent' ? ctx.actor.id : null,
    })
    .returning({ id: voiceCalls.id });
  const callId = call!.id;

  let status: VoiceCallStatus = 'queued';
  let providerCallId: string | null = null;
  let error: string | null = null;
  try {
    const started = await provider.startCall({
      callId,
      toNumber: plan.toNumber,
      customerName: plan.contact.name,
      firstMessage: plan.firstMessage,
      systemPrompt: plan.prompt,
      maxMinutes: input.maxMinutes,
      recordCall: input.recordCall,
      webhookUrl: `${publicOrigin()}/api/v1/voice/${provider.name}?t=${token}`,
    });
    providerCallId = started.providerCallId;
    if (!provider.live) status = 'not_placed';
  } catch (err) {
    status = 'failed';
    error = (err as Error).message.slice(0, 500);
  }

  await ctx.db
    .update(voiceCalls)
    .set({ status, providerCallId, error })
    .where(and(scope(ctx, voiceCalls), eq(voiceCalls.id, callId)));

  await record(ctx, {
    action: 'voice.call_placed',
    resourceType: 'voice_call',
    resourceId: callId,
    riskLevel: 'high',
    metadata: {
      provider: provider.name,
      status,
      toNumber: maskNumber(plan.toNumber),
      purpose: input.purpose.slice(0, 200),
      recordCall: input.recordCall,
      consentConfirmed: true,
    },
  });

  return { callId, status, placed: status === 'queued' };
}

/* ── After the call ───────────────────────────────────────────────────────── */

/**
 * The provider's webhook says a call changed. We do not trust what it says:
 * the token must match the call's, and the call's actual content is fetched
 * from the provider's API with our key.
 */
export async function handleCallWebhook(
  token: string,
  providerCallId: string,
  provider: VoiceProvider = getVoiceProvider(),
): Promise<'updated' | 'ignored'> {
  const db = await getDb();
  const [call] = await db
    .select()
    .from(voiceCalls)
    .where(eq(voiceCalls.providerCallId, providerCallId))
    .orderBy(desc(voiceCalls.createdAt))
    .limit(1);

  // Unknown call, or a token that is not this call's: silently ignored.
  if (!call || !call.webhookTokenHash || !safeEqual(sha256(token), call.webhookTokenHash)) return 'ignored';
  if (call.meetingId) return 'ignored'; // already finalised; webhooks retry

  const report = await provider.getCall(providerCallId);
  const ctx = await systemCtx(call.workspaceId, 'Voice agent');

  if (!report.ended) {
    await ctx.db
      .update(voiceCalls)
      .set({ status: 'in_progress', startedAt: report.startedAt ?? call.startedAt })
      .where(eq(voiceCalls.id, call.id));
    return 'updated';
  }

  const noAnswer = /no-answer|did-not-answer|voicemail|busy/i.test(report.endedReason ?? '') || report.turns.length === 0;
  const durationSeconds =
    report.startedAt && report.endedAt
      ? Math.max(0, Math.round((report.endedAt.getTime() - report.startedAt.getTime()) / 1000))
      : null;

  let meetingId: string | null = null;
  if (report.turns.some((t) => t.role === 'customer')) {
    const [contact] = call.contactId
      ? await ctx.db
          .select({ email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
          .from(contacts)
          .where(eq(contacts.id, call.contactId))
          .limit(1)
      : [];
    const contactName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || 'Contact';

    const intake = await intakeTranscript(ctx, {
      externalId: `${provider.name}:${providerCallId}`,
      source: 'voice_agent',
      title: `AI call with ${contactName}: ${call.purpose}`.slice(0, 300),
      startsAt: (report.startedAt ?? call.createdAt).toISOString(),
      ...(report.endedAt ? { endsAt: report.endedAt.toISOString() } : {}),
      ...(durationSeconds != null ? { durationSeconds } : {}),
      attendees: contact?.email ? [contact.email] : [],
      segments: report.turns.map((t) => ({
        speaker: t.role === 'agent' ? 'Figbolt voice agent' : contactName,
        text: t.text,
        startSeconds: t.startSeconds,
        isCustomer: t.role === 'customer',
      })),
    });
    meetingId = intake.meetingId;
  }

  const dnc = askedNotToBeCalled(report);
  await ctx.db
    .update(voiceCalls)
    .set({
      status: noAnswer ? 'no_answer' : 'completed',
      endedReason: report.endedReason,
      summary: report.summary,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      durationSeconds,
      meetingId,
      ...(dnc ? { outcome: 'do_not_call' as const } : {}),
    })
    .where(eq(voiceCalls.id, call.id));

  await record(ctx, {
    action: 'voice.call_completed',
    resourceType: 'voice_call',
    resourceId: call.id,
    riskLevel: 'high',
    metadata: { endedReason: report.endedReason, durationSeconds, doNotCall: dnc, meetingId },
  });
  return 'updated';
}

export async function listCallsForContact(ctx: Ctx, contactId: string, limit = 10) {
  return ctx.db
    .select({
      id: voiceCalls.id,
      purpose: voiceCalls.purpose,
      status: voiceCalls.status,
      outcome: voiceCalls.outcome,
      summary: voiceCalls.summary,
      durationSeconds: voiceCalls.durationSeconds,
      meetingId: voiceCalls.meetingId,
      error: voiceCalls.error,
      createdAt: voiceCalls.createdAt,
    })
    .from(voiceCalls)
    .where(and(scope(ctx, voiceCalls), eq(voiceCalls.contactId, contactId)))
    .orderBy(desc(voiceCalls.createdAt))
    .limit(limit);
}

/** +14155550123 -> +1415•••0123, for audit logs. */
export function maskNumber(n: string): string {
  return n.length > 8 ? `${n.slice(0, 5)}•••${n.slice(-4)}` : '•••';
}
