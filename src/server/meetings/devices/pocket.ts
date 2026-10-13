import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NotetakerPayload } from '../intake';

/**
 * Pocket (heypocket.com): a MagSafe recorder that transcribes in-person
 * conversations and calls.
 *
 * Its `transcription.completed` webhook carries the whole transcript; this
 * maps it onto the notetaker intake. Shape and signing per
 * https://docs.heypocketai.com/docs/api/webhooks:
 *
 *   X-HeyPocket-Timestamp  delivery time, Unix ms
 *   X-HeyPocket-Signature  HMAC-SHA256 of `${timestamp}.${rawBody}`
 *
 * The recording carries no attendee emails (the `user` is the device owner,
 * not the customer), so it attaches to a customer only when an existing
 * meeting matches; otherwise it arrives unlinked for a person to assign.
 */

export type PocketSegment = {
  speaker?: string;
  speakerName?: string;
  text?: string;
  start?: number;
  end?: number;
};

export type PocketEvent = {
  event?: string;
  timestamp?: string;
  recording?: {
    id?: string;
    title?: string;
    description?: string;
    duration?: number;
    recordingAt?: string;
    createdAt?: string;
  };
  transcript?: PocketSegment[];
  speakers?: Record<string, { name?: string }>;
};

/** How stale a signed delivery may be. Blocks a captured request being replayed later. */
const MAX_SKEW_MS = 5 * 60_000;

export function verifyPocketSignature(
  secret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const given = signature.trim().replace(/^sha256=/i, '').toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Null for events that carry no transcript to store. */
export function pocketToNotetaker(event: PocketEvent): NotetakerPayload | null {
  if (event.event !== 'transcription.completed') return null;

  const names = event.speakers ?? {};
  const segments = (event.transcript ?? [])
    .map((s) => {
      const text = (s.text ?? '').trim();
      if (!text) return null;
      const label = s.speakerName?.trim() || (s.speaker ? names[s.speaker]?.name?.trim() : undefined) || s.speaker || 'Speaker';
      return {
        speaker: label.slice(0, 120),
        text: text.slice(0, 20_000),
        startSeconds: Math.max(0, Math.round(s.start ?? 0)),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  if (segments.length === 0) return null;

  const rec = event.recording ?? {};
  const startsAt = rec.recordingAt ?? rec.createdAt;
  return {
    externalId: rec.id ? `pocket:${rec.id}` : undefined,
    source: 'pocket',
    title: (rec.title?.trim() || 'Conversation (Pocket)').slice(0, 300),
    ...(startsAt ? { startsAt } : {}),
    ...(typeof rec.duration === 'number' ? { durationSeconds: Math.round(rec.duration) } : {}),
    segments,
  };
}
