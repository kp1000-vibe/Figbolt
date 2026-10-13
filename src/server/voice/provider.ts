import { env } from '@/lib/env';

/**
 * Voice providers: the service that dials the phone, speaks, listens and
 * hands back a transcript.
 *
 * Kept behind one small interface so the provider is swappable — Vapi today,
 * Retell, Bland or a self-hosted stack later — and so the rules that matter
 * (approval, disclosure, consent, do-not-call) live in our code, not in a
 * vendor's dashboard where they could be changed without review.
 */

export type StartCallRequest = {
  /** Our call id; echoed back by the provider as metadata. */
  callId: string;
  toNumber: string;
  customerName: string | null;
  firstMessage: string;
  systemPrompt: string;
  maxMinutes: number;
  recordCall: boolean;
  /** Where the provider reports the call's end. Carries a per-call token. */
  webhookUrl: string;
};

/** A transcript turn, normalised. */
export type CallTurn = { role: 'agent' | 'customer'; text: string; startSeconds: number };

/** The provider's authoritative view of a call. */
export type CallReport = {
  providerCallId: string;
  ourCallId: string | null;
  ended: boolean;
  status: string;
  endedReason: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  turns: CallTurn[];
  summary: string | null;
};

export interface VoiceProvider {
  readonly name: string;
  /** False when calls are recorded but never dialled. */
  readonly live: boolean;
  startCall(request: StartCallRequest): Promise<{ providerCallId: string | null }>;
  /** Fetch the call from the provider — never trust a webhook body for this. */
  getCall(providerCallId: string): Promise<CallReport>;
}

/* ── Console: the safe default ────────────────────────────────────────────── */

class ConsoleVoiceProvider implements VoiceProvider {
  readonly name = 'console';
  readonly live = false;
  async startCall(request: StartCallRequest) {
    console.info(`[voice] console mode: would call ${request.toNumber} (call ${request.callId}). Nothing was dialled.`);
    return { providerCallId: null };
  }
  async getCall(): Promise<CallReport> {
    throw new Error('Console mode places no calls, so there is nothing to fetch.');
  }
}

/* ── Vapi ─────────────────────────────────────────────────────────────────── */

const VAPI = 'https://api.vapi.ai';

type VapiMessage = { role?: string; message?: string; secondsFromStart?: number; time?: number };
type VapiCall = {
  id: string;
  status?: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  artifact?: { messages?: VapiMessage[]; transcript?: string };
  analysis?: { summary?: string };
};

/**
 * Vapi, per https://docs.vapi.ai/api-reference/calls/create and
 * https://docs.vapi.ai/api-reference/calls/get. A transient assistant is sent
 * with every call, so the prompt and its guardrails are ours, reviewed in
 * code — not a dashboard setting someone could change.
 */
export class VapiVoiceProvider implements VoiceProvider {
  readonly name = 'vapi';
  readonly live = true;

  constructor(
    private readonly apiKey: string,
    private readonly phoneNumberId: string,
  ) {}

  async startCall(request: StartCallRequest) {
    const body = {
      phoneNumberId: this.phoneNumberId,
      customer: { number: request.toNumber, ...(request.customerName ? { name: request.customerName } : {}) },
      assistant: {
        firstMessage: request.firstMessage,
        model: {
          provider: env.VAPI_MODEL_PROVIDER,
          model: env.VAPI_MODEL,
          messages: [{ role: 'system', content: request.systemPrompt }],
        },
        ...(env.VAPI_VOICE_PROVIDER && env.VAPI_VOICE_ID
          ? { voice: { provider: env.VAPI_VOICE_PROVIDER, voiceId: env.VAPI_VOICE_ID } }
          : {}),
        maxDurationSeconds: request.maxMinutes * 60,
        // Recording only with the person's agreement; the transcript is what
        // the CRM needs either way.
        artifactPlan: { recordingEnabled: request.recordCall },
        server: { url: request.webhookUrl },
        serverMessages: ['end-of-call-report', 'status-update'],
        metadata: { figboltCallId: request.callId },
      },
    };

    const res = await fetch(`${VAPI}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`Vapi ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
    const json = (await res.json()) as { id?: string };
    return { providerCallId: json.id ?? null };
  }

  async getCall(providerCallId: string): Promise<CallReport> {
    const res = await fetch(`${VAPI}/call/${encodeURIComponent(providerCallId)}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Vapi ${res.status} fetching call ${providerCallId}`);
    return normaliseVapiCall((await res.json()) as VapiCall);
  }
}

/** Exported for tests: Vapi's call object into our report. */
export function normaliseVapiCall(call: VapiCall): CallReport {
  const turns: CallTurn[] = [];
  for (const m of call.artifact?.messages ?? []) {
    const text = (m.message ?? '').trim();
    if (!text) continue;
    // The person called is "user"; everything we said is the agent.
    // System prompts and tool traffic are never part of the transcript.
    const role = m.role === 'user' ? 'customer' : m.role === 'assistant' || m.role === 'bot' ? 'agent' : null;
    if (!role) continue;
    turns.push({ role, text, startSeconds: Math.max(0, Math.round(m.secondsFromStart ?? 0)) });
  }

  const ourCallId = typeof call.metadata?.['figboltCallId'] === 'string' ? (call.metadata['figboltCallId'] as string) : null;
  const date = (v?: string) => {
    const d = v ? new Date(v) : null;
    return d && Number.isFinite(d.getTime()) ? d : null;
  };

  return {
    providerCallId: call.id,
    ourCallId,
    ended: call.status === 'ended',
    status: call.status ?? 'unknown',
    endedReason: call.endedReason ?? null,
    startedAt: date(call.startedAt),
    endedAt: date(call.endedAt),
    turns,
    summary: call.analysis?.summary?.trim() || null,
  };
}

export function getVoiceProvider(): VoiceProvider {
  if (env.VOICE_PROVIDER === 'vapi') {
    if (env.VAPI_API_KEY && env.VAPI_PHONE_NUMBER_ID) {
      return new VapiVoiceProvider(env.VAPI_API_KEY, env.VAPI_PHONE_NUMBER_ID);
    }
    console.warn('[voice] VOICE_PROVIDER=vapi but VAPI_API_KEY or VAPI_PHONE_NUMBER_ID is missing; calls will not be placed.');
  }
  return new ConsoleVoiceProvider();
}
