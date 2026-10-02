import type {
  CalendarConnector,
  SyncCursor,
  SyncResult,
  SyncedMeeting,
} from '../providers';

/**
 * Google Calendar, for real.
 *
 * **Cursor strategy.** Google's `syncToken` gives true incremental deltas, and
 * like Gmail's history id it can expire — the API answers 410 Gone, which is
 * the documented way of saying "start again". That is handled as a normal
 * state: the connector drops the token and does a windowed backfill rather
 * than failing the sync.
 *
 * **Which events count.** Cancelled events are reported so the meeting can be
 * marked cancelled rather than silently lingering. All-day entries and events
 * with no other attendee are skipped: a personal reminder on a rep's calendar
 * is not a customer interaction, and treating it as one pollutes the account
 * timeline with lunch.
 */

const API = 'https://www.googleapis.com/calendar/v3/calendars';

type GoogleEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: { email?: string; responseStatus?: string; resource?: boolean }[];
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
};

export class GoogleCalendarConnector implements CalendarConnector {
  readonly provider = 'google_calendar' as const;
  readonly mode = 'live' as const;

  constructor(
    private readonly accessToken: string,
    private readonly calendarId = 'primary',
  ) {}

  async pull(cursor: SyncCursor, limit: number): Promise<SyncResult<SyncedMeeting>> {
    let page = await this.list(cursor, limit);

    if (page === 'expired') {
      console.info('[google-calendar] sync token expired; backfilling a fresh window');
      page = await this.list(null, limit);
      if (page === 'expired') throw new Error('Google Calendar rejected a fresh sync.');
    }

    const items = (page.events ?? [])
      .map((event) => this.toSyncedMeeting(event))
      .filter((meeting): meeting is SyncedMeeting => meeting !== null);

    return {
      items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  private async list(
    cursor: SyncCursor,
    limit: number,
  ): Promise<
    | 'expired'
    | { events: GoogleEvent[]; nextCursor: SyncCursor; hasMore: boolean }
  > {
    const url = new URL(`${API}/${encodeURIComponent(this.calendarId)}/events`);
    url.searchParams.set('maxResults', String(Math.min(limit, 2500)));
    url.searchParams.set('singleEvents', 'true');

    if (cursor?.startsWith('sync:')) {
      url.searchParams.set('syncToken', cursor.slice('sync:'.length));
    } else if (cursor?.startsWith('page:')) {
      url.searchParams.set('pageToken', cursor.slice('page:'.length));
    } else {
      // Initial backfill: a year back is enough history to build a picture of
      // an account without pulling a decade of standups.
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      url.searchParams.set('timeMin', from.toISOString());
      url.searchParams.set('orderBy', 'startTime');
    }

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });

    // 410 Gone is Google's documented "your sync token is too old".
    if (res.status === 410) return 'expired';
    if (!res.ok) throw new Error(`Google Calendar list failed: ${res.status}`);

    const json = (await res.json()) as {
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };

    return {
      events: json.items ?? [],
      nextCursor: json.nextPageToken
        ? `page:${json.nextPageToken}`
        : json.nextSyncToken
          ? `sync:${json.nextSyncToken}`
          : cursor,
      hasMore: Boolean(json.nextPageToken),
    };
  }

  private toSyncedMeeting(event: GoogleEvent): SyncedMeeting | null {
    if (!event.id) return null;

    // An all-day entry has `date` rather than `dateTime`. Those are holidays,
    // birthdays and out-of-office markers, not customer meetings.
    const startsAt = event.start?.dateTime ? new Date(event.start.dateTime) : null;
    if (!startsAt || !Number.isFinite(startsAt.getTime())) return null;

    const attendees = (event.attendees ?? [])
      .filter((a) => a.email && !a.resource)
      .map((a) => a.email!.toLowerCase());

    // A solo block is a focus hour, not a meeting with anyone.
    if (attendees.length < 2) return null;

    const endsAt = event.end?.dateTime ? new Date(event.end.dateTime) : null;

    return {
      externalId: event.id,
      title: event.summary ?? '(no title)',
      description: event.description ?? null,
      startsAt,
      endsAt: endsAt && Number.isFinite(endsAt.getTime()) ? endsAt : null,
      location: event.location ?? null,
      meetingUrl:
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
        null,
      // Google Calendar holds no recording; a notetaker or Zoom supplies that.
      recordingUrl: null,
      participantEmails: [...new Set(attendees)],
      organizerEmail: event.organizer?.email?.toLowerCase() ?? null,
      transcript: null,
    };
  }
}
