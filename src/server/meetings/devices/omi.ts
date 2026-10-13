import type { NotetakerPayload } from '../intake';

/**
 * Omi (omi.me) — an open-source pendant that records in-person conversations.
 *
 * Its "conversation created" webhook posts the finished conversation; this
 * maps it onto the notetaker intake, so a hallway conversation with a client
 * goes through the same matching, extraction and approval path as a Zoom
 * call. Shape per https://docs.omi.me (integration apps, memory creation).
 *
 * The wearer is "is_user"; everyone else is treated as the other side.
 * Pendant recordings carry no attendee emails, so they are attached to a
 * customer only when an existing meeting matches — otherwise they arrive as
 * an unlinked meeting for a person to assign, rather than being guessed.
 */

export type OmiSegment = {
  text?: string;
  speaker?: string;
  speakerId?: number;
  speaker_id?: number;
  speaker_name?: string;
  is_user?: boolean;
  start?: number;
  end?: number;
};

export type OmiConversation = {
  id?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  discarded?: boolean;
  structured?: { title?: string; overview?: string };
  transcript_segments?: OmiSegment[];
};

/** Null when there is nothing worth storing: discarded, or no speech. */
export function omiToNotetaker(conv: OmiConversation): NotetakerPayload | null {
  if (conv.discarded) return null;

  const segments = (conv.transcript_segments ?? [])
    .map((s) => {
      const text = (s.text ?? '').trim();
      if (!text) return null;
      const id = s.speakerId ?? s.speaker_id;
      const speaker = s.is_user
        ? 'Me'
        : s.speaker_name?.trim() || (typeof id === 'number' ? `Speaker ${id + 1}` : s.speaker?.trim() || 'Speaker');
      return {
        speaker: speaker.slice(0, 120),
        text: text.slice(0, 20_000),
        startSeconds: Math.max(0, Math.round(s.start ?? 0)),
        isCustomer: !s.is_user,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  if (segments.length === 0) return null;

  const startsAt = conv.started_at ?? conv.created_at;
  const title = conv.structured?.title?.trim();
  return {
    externalId: conv.id ? `omi:${conv.id}` : undefined,
    source: 'omi',
    title: (title || 'In-person conversation (Omi)').slice(0, 300),
    ...(startsAt ? { startsAt } : {}),
    ...(conv.finished_at ? { endsAt: conv.finished_at } : {}),
    segments,
  };
}
