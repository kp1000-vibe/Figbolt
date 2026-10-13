import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contacts, voiceCalls, workspaces } from '@/db/schema';
import { createHarness, type Harness } from './harness';
import { askedNotToBeCalled, handleCallWebhook, placeCall, planCall } from '@/server/voice/calls';
import { normaliseVapiCall, type CallReport, type StartCallRequest, type VoiceProvider } from '@/server/voice/provider';
import { openingLine, systemPrompt, toE164, withinCallingHours } from '@/lib/voice/script';
import { omiToNotetaker } from '@/server/meetings/devices/omi';
import { pocketToNotetaker, verifyPocketSignature } from '@/server/meetings/devices/pocket';
import { sha256 } from '@/lib/security/crypto';

/**
 * Voice-agent calls and pocket recorders.
 *
 * The voice tests pin the rules that make an AI phoning a customer
 * acceptable: it always says it is an AI, consent is required, it calls only
 * known contacts in their daytime, "stop calling me" is permanent, and the
 * transcript is taken from the provider, never from a webhook body.
 */

/* ── The script ───────────────────────────────────────────────────────────── */

describe('what the agent says', () => {
  const line = (over: Partial<Parameters<typeof openingLine>[0]> = {}) =>
    openingLine({
      callerName: 'Alex Rivera',
      businessName: 'Northwind Labs',
      contactFirstName: 'Rosa',
      purpose: 'the Atlas renewal.',
      recordCall: false,
      ...over,
    });

  it('says it is an AI in the first sentence, every time', () => {
    expect(line()).toMatch(/^Hi Rosa, this is an AI assistant calling on behalf of Alex Rivera at Northwind Labs\./);
    expect(line({ callerName: null, contactFirstName: null })).toMatch(/^Hi, this is an AI assistant/);
  });

  it('states whether the call is recorded', () => {
    expect(line()).toContain('This call is not being recorded.');
    expect(line({ recordCall: true })).toContain('This call is being recorded.');
  });

  it('keeps the purpose as written, without doubled punctuation', () => {
    expect(line({ purpose: 'Acme pricing!' })).toContain("I'm calling about Acme pricing. Is now");
  });

  it('carries the guardrails in every prompt', () => {
    const prompt = systemPrompt({
      businessName: 'Northwind Labs',
      callerName: null,
      contactName: 'Rosa Diaz',
      purpose: 'Follow up',
      talkingPoints: ['Ask about timeline'],
      maxMinutes: 5,
    });
    expect(prompt).toMatch(/Never claim to be human/);
    expect(prompt).toMatch(/Never agree to prices, discounts, contract terms/);
    expect(prompt).toMatch(/asks not to be called again/);
    expect(prompt).toMatch(/Never ask for payment details/);
    expect(prompt).toContain('- Ask about timeline');
  });
});

describe('who and when', () => {
  it('only accepts an unambiguous international number', () => {
    expect(toE164('+1 (415) 555-0123')).toBe('+14155550123');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('415-555-0123')).toBeNull(); // which country?
    expect(toE164('+0123456789')).toBeNull();
    expect(toE164(null)).toBeNull();
  });

  it('keeps to 8am-9pm in the contact\'s own time zone', () => {
    // 15:00 UTC is 11:00 in New York; 03:00 UTC is 23:00 the night before.
    expect(withinCallingHours('America/New_York', new Date('2026-10-12T15:00:00Z'))).toBe(true);
    expect(withinCallingHours('America/New_York', new Date('2026-10-12T03:00:00Z'))).toBe(false);
    expect(withinCallingHours('Asia/Kolkata', new Date('2026-10-12T20:00:00Z'))).toBe(false); // 01:30
    expect(withinCallingHours(null)).toBeNull();
    expect(withinCallingHours('Not/AZone')).toBeNull();
  });

  it('hears "stop calling me" in what the customer said, not the agent', () => {
    const turns = (role: 'agent' | 'customer', text: string) => ({ turns: [{ role, text, startSeconds: 0 }] });
    expect(askedNotToBeCalled(turns('customer', 'Please take me off your list.'))).toBe(true);
    expect(askedNotToBeCalled(turns('customer', "Don't call this number again"))).toBe(true);
    expect(askedNotToBeCalled(turns('agent', 'I will make sure we do not call again.'))).toBe(false);
    expect(askedNotToBeCalled(turns('customer', 'Sounds good, call me Friday.'))).toBe(false);
  });
});

describe('reading a Vapi call', () => {
  it('keeps the conversation and drops system prompts and tool traffic', () => {
    const report = normaliseVapiCall({
      id: 'vapi_1',
      status: 'ended',
      endedReason: 'customer-ended-call',
      startedAt: '2026-10-12T15:00:00Z',
      endedAt: '2026-10-12T15:03:00Z',
      artifact: {
        messages: [
          { role: 'system', message: 'You are an AI assistant…' },
          { role: 'assistant', message: 'Hi Rosa, this is an AI assistant.', secondsFromStart: 0.4 },
          { role: 'user', message: 'Hi, yes.', secondsFromStart: 3.6 },
          { role: 'tool-call', message: 'lookup()' },
          { role: 'user', message: '   ' },
        ],
      },
      analysis: { summary: 'Rosa will decide next week.' },
    });
    expect(report.ended).toBe(true);
    expect(report.turns).toEqual([
      { role: 'agent', text: 'Hi Rosa, this is an AI assistant.', startSeconds: 0 },
      { role: 'customer', text: 'Hi, yes.', startSeconds: 4 },
    ]);
    expect(report.summary).toBe('Rosa will decide next week.');
  });
});

/* ── Placing and finishing calls ──────────────────────────────────────────── */

class FakeProvider implements VoiceProvider {
  readonly name = 'vapi';
  readonly live = true;
  started: StartCallRequest[] = [];
  report: CallReport | null = null;
  fetched = 0;
  async startCall(request: StartCallRequest) {
    this.started.push(request);
    return { providerCallId: `vapi_${this.started.length}` };
  }
  async getCall(providerCallId: string): Promise<CallReport> {
    this.fetched += 1;
    return { ...this.report!, providerCallId };
  }
}

describe('placing a call', () => {
  let h: Harness;
  let contactId: string;
  let nightOwlId: string;
  let noPhoneId: string;

  beforeAll(async () => {
    h = await createHarness();
    const add = async (values: Partial<typeof contacts.$inferInsert>) =>
      (
        await h.db
          .insert(contacts)
          .values({ workspaceId: h.workspaceId, firstName: 'Rosa', lastName: 'Diaz', ...values })
          .returning({ id: contacts.id })
      )[0]!.id;
    contactId = await add({ phone: '+1 415 555 0123', email: 'rosa@atlas.example', accountId: h.accountId });
    // Whatever the real clock says, a zone 12 hours away is the opposite part
    // of the day — pick whichever is outside 8am-9pm right now.
    const zone = withinCallingHours('Pacific/Kiritimati') ? 'Etc/GMT+10' : 'Pacific/Kiritimati';
    nightOwlId = await add({ phone: '+16465550199', timezone: withinCallingHours(zone) ? 'Etc/GMT-12' : zone });
    noPhoneId = await add({ phone: null });
  });
  afterAll(() => h.cleanup());

  const input = (over: Partial<Parameters<typeof placeCall>[1]> = {}) => ({
    contactId,
    purpose: 'Following up on the Atlas proposal',
    talkingPoints: ['Ask about the decision date'],
    maxMinutes: 5,
    recordCall: false,
    consentConfirmed: true,
    ...over,
  });

  it('refuses without confirmed consent', async () => {
    await expect(planCall(h.ctxFor('member'), input({ consentConfirmed: false }))).rejects.toThrow(/consent/);
  });

  it('refuses a contact with no international number, or no contact at all', async () => {
    await expect(planCall(h.ctxFor('member'), input({ contactId: noPhoneId }))).rejects.toThrow(/phone number/);
    await expect(planCall(h.ctxFor('member'), input({ contactId: 'con_missing' }))).rejects.toThrow(/existing contact/);
  });

  it('refuses outside 8am-9pm for the contact', async () => {
    const [row] = await h.db.select({ tz: contacts.timezone }).from(contacts).where(eq(contacts.id, nightOwlId));
    // Only meaningful when the chosen zone is genuinely night now.
    if (withinCallingHours(row!.tz) === false) {
      await expect(planCall(h.ctxFor('member'), input({ contactId: nightOwlId }))).rejects.toThrow(/outside 8am-9pm/);
    }
  });

  it('never calls another workspace\'s contact', async () => {
    await expect(planCall(h.otherCtx, input())).rejects.toThrow(/existing contact/);
  });

  it('dials with the disclosure, and stores only a hash of the webhook token', async () => {
    const provider = new FakeProvider();
    const result = await placeCall(h.ctxFor('member'), input(), provider);

    expect(result.status).toBe('queued');
    const sent = provider.started[0]!;
    expect(sent.toNumber).toBe('+14155550123');
    expect(sent.firstMessage).toMatch(/this is an AI assistant/);
    expect(sent.systemPrompt).toMatch(/Never claim to be human/);

    const token = new URL(sent.webhookUrl).searchParams.get('t')!;
    const [row] = await h.db.select().from(voiceCalls).where(eq(voiceCalls.id, result.callId));
    expect(row!.webhookTokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.consentConfirmedById).toBeTruthy();
  });

  it('records but does not dial without a provider', async () => {
    const { placeCall: place } = await import('@/server/voice/calls');
    const result = await place(h.ctxFor('member'), input());
    expect(result.status).toBe('not_placed');
    expect(result.placed).toBe(false);
  });

  it('takes the transcript from the provider, ignores bad tokens, and honours "stop calling"', async () => {
    const provider = new FakeProvider();
    const { callId } = await placeCall(h.ctxFor('member'), input(), provider);
    const sent = provider.started[0]!;
    const token = new URL(sent.webhookUrl).searchParams.get('t')!;
    const providerCallId = 'vapi_1';

    // A forged webhook with the wrong token does nothing — not even a fetch.
    expect(await handleCallWebhook('not-the-token', providerCallId, provider)).toBe('ignored');
    expect(provider.fetched).toBe(0);

    provider.report = {
      providerCallId,
      ourCallId: callId,
      ended: true,
      status: 'ended',
      endedReason: 'customer-ended-call',
      startedAt: new Date('2026-10-12T15:00:00Z'),
      endedAt: new Date('2026-10-12T15:02:30Z'),
      turns: [
        { role: 'agent', text: 'Hi Rosa, this is an AI assistant calling about the proposal.', startSeconds: 0 },
        { role: 'customer', text: 'We are still reviewing it. Also, please stop calling me.', startSeconds: 5 },
      ],
      summary: 'Rosa asked not to be called again.',
    };

    expect(await handleCallWebhook(token, providerCallId, provider)).toBe('updated');
    const [row] = await h.db.select().from(voiceCalls).where(eq(voiceCalls.id, callId));
    expect(row!.status).toBe('completed');
    expect(row!.outcome).toBe('do_not_call');
    expect(row!.durationSeconds).toBe(150);
    expect(row!.meetingId).toBeTruthy();

    // A retried webhook is absorbed.
    expect(await handleCallWebhook(token, providerCallId, provider)).toBe('ignored');

    // And the number is now blocked for good.
    await expect(planCall(h.ctxFor('member'), input())).rejects.toThrow(/asked not to be called/);
  });

  it('never lets an agent place a call without a person, whatever the policy', async () => {
    const { dispatchTool, ensureToolsLoaded } = await import('@/lib/agents/dispatch');
    await ensureToolsLoaded();
    await h.db
      .update(workspaces)
      .set({ aiSettings: { autoApprove: { low: true, medium: true, high: true } } as never })
      .where(eq(workspaces.id, h.workspaceId));

    const agentCtx = {
      ...h.ctxFor('member'),
      actor: { type: 'agent' as const, id: h.agentId, label: 'Test agent' },
    };
    const fresh = await h.db
      .insert(contacts)
      .values({ workspaceId: h.workspaceId, firstName: 'Sam', lastName: 'Lee', phone: '+14155550188' })
      .returning({ id: contacts.id });

    const outcome = await dispatchTool(agentCtx, 'place_call', input({ contactId: fresh[0]!.id }), {
      agentId: h.agentId,
      autoApprove: ['low', 'medium', 'high'],
    });
    expect(outcome.status).toBe('needs_approval');
    if (outcome.status === 'needs_approval') {
      expect(outcome.preview.kind).toBe('text');
      expect(JSON.stringify(outcome.preview)).toMatch(/this is an AI assistant/);
      expect(JSON.stringify(outcome.preview)).toMatch(/By approving, you confirm/);
    }
  });
});

/* ── Pocket recorders ─────────────────────────────────────────────────────── */

describe('Omi pendant', () => {
  it('maps a conversation, with the wearer as "Me" and everyone else as the other side', () => {
    const payload = omiToNotetaker({
      id: 'conv_1',
      started_at: '2026-10-12T15:00:00Z',
      structured: { title: 'Coffee with Rosa' },
      transcript_segments: [
        { text: 'Thanks for meeting.', is_user: true, start: 0 },
        { text: 'Happy to. Budget is approved.', is_user: false, speaker_name: 'Rosa', start: 2.6 },
        { text: '   ', is_user: false },
      ],
    })!;
    expect(payload.externalId).toBe('omi:conv_1');
    expect(payload.title).toBe('Coffee with Rosa');
    expect(payload.segments).toEqual([
      { speaker: 'Me', text: 'Thanks for meeting.', startSeconds: 0, isCustomer: false },
      { speaker: 'Rosa', text: 'Happy to. Budget is approved.', startSeconds: 3, isCustomer: true },
    ]);
  });

  it('stores nothing for a discarded or silent conversation', () => {
    expect(omiToNotetaker({ id: 'x', discarded: true, transcript_segments: [{ text: 'hi' }] })).toBeNull();
    expect(omiToNotetaker({ id: 'y', transcript_segments: [] })).toBeNull();
  });
});

describe('Pocket recorder', () => {
  const event = {
    event: 'transcription.completed',
    recording: { id: 'rec_9', title: 'Site visit', duration: 1800.4, recordingAt: '2026-10-12T15:00:00Z' },
    transcript: [
      { speaker: 'SPEAKER_00', text: 'Shall we start?', start: 0 },
      { speaker: 'SPEAKER_01', speakerName: 'Rosa', text: 'Yes, go ahead.', start: 1.2 },
    ],
    speakers: { SPEAKER_00: { name: 'Alex' } },
  };

  it('maps a finished transcription, resolving speaker names', () => {
    const payload = pocketToNotetaker(event)!;
    expect(payload.externalId).toBe('pocket:rec_9');
    expect(payload.durationSeconds).toBe(1800);
    expect(payload.segments!.map((s) => s.speaker)).toEqual(['Alex', 'Rosa']);
  });

  it('ignores events that carry no transcript', () => {
    expect(pocketToNotetaker({ ...event, event: 'summary.completed' })).toBeNull();
    expect(pocketToNotetaker({ ...event, transcript: [] })).toBeNull();
  });

  it('accepts only fresh deliveries signed with the right secret', () => {
    const body = JSON.stringify(event);
    const now = 1_760_000_000_000;
    const sign = (secret: string, ts: number, b = body) =>
      createHmac('sha256', secret).update(`${ts}.${b}`).digest('hex');

    expect(verifyPocketSignature('s3cret', body, String(now), sign('s3cret', now), now)).toBe(true);
    expect(verifyPocketSignature('s3cret', body, String(now), `sha256=${sign('s3cret', now)}`, now)).toBe(true);
    // Tampered body, wrong secret, missing headers, a replay ten minutes late.
    expect(verifyPocketSignature('s3cret', body.replace('Rosa', 'Eve'), String(now), sign('s3cret', now), now)).toBe(false);
    expect(verifyPocketSignature('s3cret', body, String(now), sign('other', now), now)).toBe(false);
    expect(verifyPocketSignature('s3cret', body, null, sign('s3cret', now), now)).toBe(false);
    expect(verifyPocketSignature('s3cret', body, String(now), sign('s3cret', now), now + 10 * 60_000)).toBe(false);
  });
});
