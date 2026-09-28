/**
 * iCalendar (RFC 5545) invite generation.
 *
 * This is the part of scheduling that works everywhere. An .ics attachment
 * with METHOD:REQUEST is what Outlook, Gmail, Apple Mail and every other
 * client turn into an "Accept / Decline" card — no OAuth, no per-tenant app
 * registration, no calendar API. So even with CALENDAR_PROVIDER=console the
 * customer gets a real, acceptable invitation.
 *
 * The provider adapters in ./providers.ts are the upgrade on top of this: they
 * put the event on the *rep's own* calendar and give us an event id we can use
 * to update or cancel later. Both paths produce the same UID, so an event
 * created through Google and an .ics sent by email are the same meeting to the
 * recipient's client rather than two competing entries.
 */

export type IcsAttendee = { email: string; name?: string; required?: boolean };

export type IcsEvent = {
  /** Stable across updates and cancellations. Ours, not the provider's. */
  uid: string;
  title: string;
  description?: string;
  location?: string;
  meetingUrl?: string;
  startsAt: Date;
  endsAt: Date;
  organizer: { email: string; name?: string };
  attendees: IcsAttendee[];
  /** Incremented on each update; recipients' clients use it to supersede. */
  sequence?: number;
  method?: 'REQUEST' | 'CANCEL';
};

/** RFC 5545 wants UTC timestamps as YYYYMMDDTHHMMSSZ. */
export function icsStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Escape a TEXT value: backslash, semicolon, comma and newline are special.
 * Order matters — backslashes must be escaped before anything that adds one.
 */
function escapeText(value: string): string {
  const BACKSLASH = String.fromCharCode(92);
  return value
    .replace(/\\/g, BACKSLASH + BACKSLASH)
    .replace(/;/g, BACKSLASH + ';')
    .replace(/,/g, BACKSLASH + ',')
    .replace(/\r?\n/g, BACKSLASH + 'n');
}

/**
 * Fold lines at 75 octets, as the spec requires.
 *
 * Counted in UTF-8 bytes rather than characters, because a line split in the
 * middle of a multi-byte character is what makes an invite fail to parse in
 * Outlook while looking fine in every test written with ASCII.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0;
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Walk back off a continuation byte so we never split a code point.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines start with a space, which counts
  }

  return out.join('\r\n ');
}

export function buildIcs(event: IcsEvent): string {
  const method = event.method ?? 'REQUEST';
  const status = method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED';

  const descriptionParts = [event.description?.trim(), event.meetingUrl ? `Join: ${event.meetingUrl}` : '']
    .filter(Boolean)
    .join('\n\n');

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Figbolt//CRM//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(event.startsAt)}`,
    `DTEND:${icsStamp(event.endsAt)}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${status}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (descriptionParts) lines.push(`DESCRIPTION:${escapeText(descriptionParts)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.meetingUrl) lines.push(`URL:${escapeText(event.meetingUrl)}`);

  lines.push(
    `ORGANIZER;CN=${escapeText(event.organizer.name ?? event.organizer.email)}:mailto:${event.organizer.email}`,
  );

  for (const attendee of event.attendees) {
    const role = attendee.required === false ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT';
    lines.push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE;` +
        `CN=${escapeText(attendee.name ?? attendee.email)}:mailto:${attendee.email}`,
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // CRLF throughout, per the spec; some clients reject bare LF.
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** A UID that is stable for a meeting and unique to this workspace. */
export function icsUid(meetingId: string, host = 'figbolt.com'): string {
  return `${meetingId}@${host}`;
}
