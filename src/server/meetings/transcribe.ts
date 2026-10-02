import { and, eq } from 'drizzle-orm';
import {
  meetingParticipants,
  meetings,
  transcripts,
  users,
  workspaceMembers,
  type TranscriptSegment,
} from '@/db/schema';
import { env } from '@/lib/env';
import { scope, ValidationError, type Ctx } from '../context';
import { record } from '../audit';

/**
 * Turning a meeting recording into a transcript.
 *
 * Two things this module is careful about.
 *
 * **Speaker attribution is a permission question, not a cosmetic one.** Every
 * segment carries `isCustomer`, and the extraction downstream treats customer
 * speech as untrusted input while weighting it more heavily as evidence of what
 * the customer wants. Guessing wrong in the "internal" direction would let a
 * sentence spoken by a customer be trusted; guessing wrong the other way only
 * loses signal. So attribution is resolved against the workspace's own user
 * list and participant roster, and **anything unrecognised is treated as the
 * customer** — the safe direction.
 *
 * **A transcript is evidence, so it is written once and never edited.** Re-running
 * extraction re-reads the same segments (see /api/meetings/reprocess). If a
 * transcription is wrong, the fix is a new transcript, not a mutated one.
 */

export type TranscriptionResult = {
  transcriptId: string;
  segmentCount: number;
  durationSeconds: number | null;
  provider: string;
  language: string;
};

/** What a speech-to-text service gives back, normalised. */
export type RawUtterance = {
  speaker: string;
  text: string;
  startSeconds: number;
  /** Present when the provider can map a voice to an invited address. */
  speakerEmail?: string;
};

export interface TranscriptionProvider {
  readonly name: string;
  /** False when no audio is actually processed. */
  readonly transcribes: boolean;
  transcribe(recordingUrl: string): Promise<{ utterances: RawUtterance[]; durationSeconds: number | null; language: string }>;
}

class DisabledTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'none';
  readonly transcribes = false;
  async transcribe(): Promise<never> {
    throw new ValidationError(
      'Automatic transcription is off. Run a local Whisper server and set ' +
        'TRANSCRIPTION_PROVIDER=local for a free, self-hosted option — or paste ' +
        'the transcript in.',
    );
  }
}

class DeepgramProvider implements TranscriptionProvider {
  readonly name = 'deepgram';
  readonly transcribes = true;
  constructor(private readonly apiKey: string) {}

  async transcribe(recordingUrl: string) {
    // diarize splits speakers; utterances groups the words back into turns,
    // which is what makes a transcript readable rather than a wall of tokens.
    const res = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&diarize=true&utterances=true&punctuate=true&smart_format=true',
      {
        method: 'POST',
        headers: { authorization: `Token ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: recordingUrl }),
        signal: AbortSignal.timeout(300_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Deepgram rejected the recording: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    }

    const json = (await res.json()) as {
      metadata?: { duration?: number };
      results?: {
        utterances?: { speaker?: number; transcript?: string; start?: number }[];
        channels?: { detected_language?: string }[];
      };
    };

    const utterances = (json.results?.utterances ?? [])
      .filter((u) => (u.transcript ?? '').trim().length > 0)
      .map((u) => ({
        speaker: `Speaker ${(u.speaker ?? 0) + 1}`,
        text: (u.transcript ?? '').trim(),
        startSeconds: Math.round(u.start ?? 0),
      }));

    return {
      utterances,
      durationSeconds: json.metadata?.duration ? Math.round(json.metadata.duration) : null,
      language: json.results?.channels?.[0]?.detected_language ?? 'en',
    };
  }
}

/**
 * Any server speaking Whisper's `/v1/audio/transcriptions` API.
 *
 * One implementation covers two very different deployments, because the wire
 * format is the same:
 *
 *   openai   api.openai.com, paid per minute
 *   local    whisper.cpp, faster-whisper, Speaches or LocalAI on your own
 *            hardware - free, open source, and the audio never leaves it
 *
 * The local case is the one that matters for a small team. Meeting
 * transcription billed per minute is a cost that scales with exactly the
 * behaviour the product is trying to encourage, which is a bad shape; a
 * self-hosted Whisper removes it entirely.
 */
class WhisperApiProvider implements TranscriptionProvider {
  readonly transcribes = true;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string | null,
    /** Local CPU transcription is far slower than a hosted GPU. */
    private readonly timeoutMs: number,
  ) {}

  async transcribe(recordingUrl: string) {
    const audio = await fetch(recordingUrl, { signal: AbortSignal.timeout(120_000) });
    if (!audio.ok) throw new Error(`Could not fetch the recording: ${audio.status}`);

    const form = new FormData();
    form.append('file', new Blob([await audio.arrayBuffer()]), 'recording.mp4');
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      // A local server needs no key; sending an empty bearer breaks some.
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(
        `${this.name} rejected the recording: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300),
      );
    }

    const json = (await res.json()) as {
      duration?: number;
      language?: string;
      segments?: { text?: string; start?: number }[];
    };

    // Whisper does not diarize, in either deployment. Rather than invent
    // speakers, every segment is attributed to "Unknown speaker", which the
    // resolver below then treats as customer speech — the conservative
    // direction. Pair it with a notetaker, or edit the transcript, if speaker
    // attribution matters for a given meeting.
    const utterances = (json.segments ?? [])
      .filter((s) => (s.text ?? '').trim().length > 0)
      .map((s) => ({
        speaker: 'Unknown speaker',
        text: (s.text ?? '').trim(),
        startSeconds: Math.round(s.start ?? 0),
      }));

    return {
      utterances,
      durationSeconds: json.duration ? Math.round(json.duration) : null,
      language: json.language ?? 'en',
    };
  }
}

export function getTranscriptionProvider(): TranscriptionProvider {
  const live = env.INTEGRATION_MODE === 'live';

  /*
   * `local` is deliberately NOT gated on INTEGRATION_MODE.
   *
   * That flag is a data-egress guard: it exists so a copied production .env
   * cannot start shipping customer audio to a third party from someone's
   * laptop. A self-hosted Whisper sends the audio nowhere - it is the same
   * machine, or one the operator runs - so there is nothing to guard against,
   * and gating it would only make the free option the hardest to turn on.
   */
  if (env.TRANSCRIPTION_PROVIDER === 'local') {
    return new WhisperApiProvider(
      'local-whisper',
      env.WHISPER_BASE_URL,
      env.WHISPER_MODEL,
      null,
      // A CPU transcribing an hour of audio can take several minutes.
      30 * 60_000,
    );
  }

  if (env.TRANSCRIPTION_PROVIDER === 'deepgram' && live && env.DEEPGRAM_API_KEY) {
    return new DeepgramProvider(env.DEEPGRAM_API_KEY);
  }
  if (env.TRANSCRIPTION_PROVIDER === 'openai' && live && env.OPENAI_API_KEY) {
    return new WhisperApiProvider(
      'openai',
      'https://api.openai.com/v1',
      'whisper-1',
      env.OPENAI_API_KEY,
      5 * 60_000,
    );
  }
  return new DisabledTranscriptionProvider();
}

/** True when transcription costs nothing per minute. */
export function transcriptionIsFree(): boolean {
  return env.TRANSCRIPTION_PROVIDER === 'local';
}

export function transcriptionAvailable(): boolean {
  return getTranscriptionProvider().transcribes;
}

/**
 * Transcribe a meeting's recording, then hand off to extraction.
 *
 * Marks the meeting `pending` before the provider call so a job that dies
 * mid-flight is visible as stuck rather than as never-started.
 */
export async function transcribeMeeting(ctx: Ctx, meetingId: string): Promise<TranscriptionResult> {
  const [meeting] = await ctx.db
    .select()
    .from(meetings)
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)))
    .limit(1);
  if (!meeting) throw new ValidationError('No such meeting.');
  if (!meeting.recordingUrl) {
    throw new ValidationError('That meeting has no recording to transcribe.');
  }

  const [existing] = await ctx.db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(and(scope(ctx, transcripts), eq(transcripts.meetingId, meetingId)))
    .limit(1);
  if (existing) {
    throw new ValidationError('That meeting already has a transcript. Reprocess it instead.');
  }

  const provider = getTranscriptionProvider();

  await ctx.db
    .update(meetings)
    .set({ transcriptionStatus: 'pending', transcriptionError: null })
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));

  let raw: Awaited<ReturnType<TranscriptionProvider['transcribe']>>;
  try {
    raw = await provider.transcribe(meeting.recordingUrl);
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    await ctx.db
      .update(meetings)
      .set({
        transcriptionStatus: provider.transcribes ? 'failed' : 'unsupported',
        transcriptionError: message,
      })
      .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));
    throw err;
  }

  const segments = await attributeSpeakers(ctx, meetingId, raw.utterances);
  const fullText = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');

  const [row] = await ctx.db
    .insert(transcripts)
    .values({
      workspaceId: ctx.workspaceId,
      meetingId,
      source: provider.name,
      language: raw.language,
      segments,
      fullText,
      durationSeconds: raw.durationSeconds,
    })
    .returning({ id: transcripts.id });

  await ctx.db
    .update(meetings)
    .set({ transcriptionStatus: 'done', transcriptionError: null })
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));

  await record(ctx, {
    action: 'meeting.transcribed',
    resourceType: 'meeting',
    resourceId: meetingId,
    riskLevel: 'low',
    metadata: {
      provider: provider.name,
      segments: segments.length,
      durationSeconds: raw.durationSeconds,
    },
  });

  // Extraction reads the transcript we just wrote and fills in the summary.
  const { ingestMeeting } = await import('../memory/ingest');
  await ingestMeeting(ctx, meetingId);

  return {
    transcriptId: row!.id,
    segmentCount: segments.length,
    durationSeconds: raw.durationSeconds,
    provider: provider.name,
    language: raw.language,
  };
}

/**
 * Decide, per utterance, whether the speaker is one of ours.
 *
 * Resolution order, most reliable first:
 *   1. the provider gave us an address that matches a workspace user
 *   2. the speaker label matches an internal participant's name
 *   3. anything else is treated as the customer
 *
 * Rule 3 is the load-bearing one. Marking a customer's sentence as internal
 * would let untrusted speech be treated as a colleague's instruction, so an
 * unrecognised voice is always the customer.
 */
async function attributeSpeakers(
  ctx: Ctx,
  meetingId: string,
  utterances: RawUtterance[],
): Promise<TranscriptSegment[]> {
  const participants = await ctx.db
    .select({
      email: meetingParticipants.email,
      name: meetingParticipants.name,
      userId: meetingParticipants.userId,
    })
    .from(meetingParticipants)
    .where(and(scope(ctx, meetingParticipants), eq(meetingParticipants.meetingId, meetingId)));

  // Users are global; membership is what makes someone "one of ours" here.
  const workspaceUsers = await ctx.db
    .select({ email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));

  const internalEmails = new Set(
    [
      ...workspaceUsers.map((u) => u.email),
      ...participants.filter((p) => p.userId).map((p) => p.email),
    ]
      .filter(Boolean)
      .map((e) => e!.toLowerCase()),
  );

  const internalNames = new Set(
    participants
      .filter((p) => p.userId && p.name)
      .map((p) => p.name!.toLowerCase().trim()),
  );

  return utterances.map((u, index) => {
    const email = u.speakerEmail?.toLowerCase();
    const label = u.speaker.toLowerCase().trim();

    const internal =
      (email !== undefined && internalEmails.has(email)) || internalNames.has(label);

    return {
      index,
      speaker: u.speaker,
      ...(u.speakerEmail ? { speakerEmail: u.speakerEmail } : {}),
      isCustomer: !internal,
      startSeconds: u.startSeconds,
      text: u.text,
    };
  });
}

/**
 * Accept a transcript someone pasted or uploaded.
 *
 * The path that works with no provider at all, and the one a rep uses when
 * their notetaker already produced a transcript. Lines are parsed as
 * "Speaker: text"; anything without that shape is attached to the previous
 * speaker so a pasted paragraph still lands intact.
 */
export async function importTranscript(
  ctx: Ctx,
  meetingId: string,
  text: string,
): Promise<TranscriptionResult> {
  const [meeting] = await ctx.db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)))
    .limit(1);
  if (!meeting) throw new ValidationError('No such meeting.');

  const trimmed = text.trim();
  if (trimmed.length < 20) throw new ValidationError('That transcript is too short to use.');
  if (trimmed.length > 500_000) throw new ValidationError('That transcript is too large.');

  const utterances: RawUtterance[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const content = line.trim();
    if (!content) continue;

    // "Name: said something" — the colon must come before any sentence end, or
    // a line like "We agreed: ship it" would invent a speaker called "We agreed".
    const match = content.match(/^([A-Za-z][\w .'-]{0,40}):\s+(.*)$/);
    if (match) {
      utterances.push({ speaker: match[1]!.trim(), text: match[2]!.trim(), startSeconds: 0 });
    } else if (utterances.length > 0) {
      utterances[utterances.length - 1]!.text += ` ${content}`;
    } else {
      utterances.push({ speaker: 'Unknown speaker', text: content, startSeconds: 0 });
    }
  }

  if (utterances.length === 0) throw new ValidationError('Could not read any speech from that.');

  const segments = await attributeSpeakers(ctx, meetingId, utterances);
  const fullText = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');

  const [row] = await ctx.db
    .insert(transcripts)
    .values({
      workspaceId: ctx.workspaceId,
      meetingId,
      source: 'upload',
      language: 'en',
      segments,
      fullText,
      durationSeconds: null,
    })
    .returning({ id: transcripts.id });

  await ctx.db
    .update(meetings)
    .set({ transcriptionStatus: 'done', transcriptionError: null })
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));

  await record(ctx, {
    action: 'meeting.transcript_imported',
    resourceType: 'meeting',
    resourceId: meetingId,
    riskLevel: 'low',
    metadata: { segments: segments.length, characters: trimmed.length },
  });

  const { ingestMeeting } = await import('../memory/ingest');
  await ingestMeeting(ctx, meetingId);

  return {
    transcriptId: row!.id,
    segmentCount: segments.length,
    durationSeconds: null,
    provider: 'upload',
    language: 'en',
  };
}
