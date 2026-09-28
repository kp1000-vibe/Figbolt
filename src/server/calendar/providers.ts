import { env } from '@/lib/env';
import type { IcsEvent } from './ics';

/**
 * Calendar write adapters.
 *
 * Same shape as EmailProvider in server/email/send.ts, for the same reason:
 * the pipeline, the bookkeeping and the error handling are exercised whether
 * or not anything is actually connected, so turning on a real calendar is a
 * configuration change plus one adapter.
 *
 * `delivers: false` is the default. A demo workspace creating events in a real
 * person's Outlook would be a serious bug, and the .ics invite built in
 * ./ics.ts already gives the recipient a genuine Accept/Decline card, so the
 * console adapter is useful rather than a stub that throws.
 *
 * Note on auth: the real adapters take an access token belonging to the
 * *organising user*, not a workspace-wide service credential. That is
 * deliberate — an event has to appear on the rep's own calendar, and it keeps
 * the blast radius of a leaked token to one mailbox. Tokens come from the
 * existing per-user integration connections (see server/integrations/manage).
 */

export type CalendarEventResult = {
  /** The provider's event id, for later update or cancellation. */
  eventId: string | null;
  /** A link the organiser can open, when the provider returns one. */
  htmlLink?: string | null;
  /** A generated conferencing URL (Meet/Teams), when one was requested. */
  meetingUrl?: string | null;
};

export interface CalendarProvider {
  readonly name: string;
  /** False when nothing reaches a real calendar. */
  readonly delivers: boolean;
  createEvent(event: IcsEvent, auth: CalendarAuth): Promise<CalendarEventResult>;
  cancelEvent(eventId: string, auth: CalendarAuth): Promise<void>;
}

export type CalendarAuth = {
  /** OAuth access token for the organising user. */
  accessToken: string;
  /** The calendar to write to. Defaults to the user's primary. */
  calendarId?: string;
};

class ConsoleCalendarProvider implements CalendarProvider {
  readonly name = 'console';
  readonly delivers = false;

  async createEvent(event: IcsEvent): Promise<CalendarEventResult> {
    console.info(
      `[calendar:console] would create "${event.title}" ` +
        `${event.startsAt.toISOString()} → ${event.endsAt.toISOString()} ` +
        `for ${event.attendees.map((a) => a.email).join(', ')}. ` +
        'Set CALENDAR_PROVIDER to write to a real calendar.',
    );
    return { eventId: null, htmlLink: null, meetingUrl: event.meetingUrl ?? null };
  }

  async cancelEvent(eventId: string): Promise<void> {
    console.info(`[calendar:console] would cancel event ${eventId}.`);
  }
}

class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google';
  readonly delivers = true;

  async createEvent(event: IcsEvent, auth: CalendarAuth): Promise<CalendarEventResult> {
    const calendarId = encodeURIComponent(auth.calendarId ?? 'primary');
    // sendUpdates=all is what makes Google email the invitation.
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events` +
      `?sendUpdates=all&conferenceDataVersion=1`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Our UID, so an .ics fallback and the API event are the same meeting.
        iCalUID: event.uid,
        summary: event.title,
        description: event.description,
        location: event.location,
        start: { dateTime: event.startsAt.toISOString() },
        end: { dateTime: event.endsAt.toISOString() },
        attendees: event.attendees.map((a) => ({
          email: a.email,
          displayName: a.name,
          optional: a.required === false,
        })),
        ...(event.meetingUrl
          ? {}
          : {
              conferenceData: {
                createRequest: {
                  requestId: event.uid,
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              },
            }),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(
        `Google Calendar rejected the event: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300),
      );
    }

    const json = (await res.json()) as {
      id?: string;
      htmlLink?: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: { uri?: string }[] };
    };

    return {
      eventId: json.id ?? null,
      htmlLink: json.htmlLink ?? null,
      meetingUrl:
        event.meetingUrl ??
        json.hangoutLink ??
        json.conferenceData?.entryPoints?.[0]?.uri ??
        null,
    };
  }

  async cancelEvent(eventId: string, auth: CalendarAuth): Promise<void> {
    const calendarId = encodeURIComponent(auth.calendarId ?? 'primary');
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${auth.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    // 410 means it was already gone, which is the outcome we wanted.
    if (!res.ok && res.status !== 410) {
      throw new Error(`Google Calendar rejected the cancellation: ${res.status}`);
    }
  }
}

class MicrosoftCalendarProvider implements CalendarProvider {
  readonly name = 'microsoft';
  readonly delivers = true;

  async createEvent(event: IcsEvent, auth: CalendarAuth): Promise<CalendarEventResult> {
    const path = auth.calendarId
      ? `/me/calendars/${encodeURIComponent(auth.calendarId)}/events`
      : '/me/events';

    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject: event.title,
        body: { contentType: 'text', content: event.description ?? '' },
        start: { dateTime: event.startsAt.toISOString(), timeZone: 'UTC' },
        end: { dateTime: event.endsAt.toISOString(), timeZone: 'UTC' },
        location: event.location ? { displayName: event.location } : undefined,
        attendees: event.attendees.map((a) => ({
          emailAddress: { address: a.email, name: a.name },
          type: a.required === false ? 'optional' : 'required',
        })),
        // Graph creates the Teams link itself when asked.
        isOnlineMeeting: !event.meetingUrl,
        onlineMeetingProvider: event.meetingUrl ? undefined : 'teamsForBusiness',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(
        `Microsoft Graph rejected the event: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300),
      );
    }

    const json = (await res.json()) as {
      id?: string;
      webLink?: string;
      onlineMeeting?: { joinUrl?: string };
    };

    return {
      eventId: json.id ?? null,
      htmlLink: json.webLink ?? null,
      meetingUrl: event.meetingUrl ?? json.onlineMeeting?.joinUrl ?? null,
    };
  }

  async cancelEvent(eventId: string, auth: CalendarAuth): Promise<void> {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${auth.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Microsoft Graph rejected the cancellation: ${res.status}`);
    }
  }
}

export function getCalendarProvider(): CalendarProvider {
  // Live mode is a second switch on purpose: a copied production .env should
  // not start writing to calendars from someone's laptop.
  const live = env.INTEGRATION_MODE === 'live';

  if (env.CALENDAR_PROVIDER === 'google' && live && env.GOOGLE_OAUTH_CLIENT_ID) {
    return new GoogleCalendarProvider();
  }
  if (env.CALENDAR_PROVIDER === 'microsoft' && live && env.MICROSOFT_OAUTH_CLIENT_ID) {
    return new MicrosoftCalendarProvider();
  }
  if (env.CALENDAR_PROVIDER !== 'console') {
    console.warn(
      `[calendar] CALENDAR_PROVIDER=${env.CALENDAR_PROVIDER} is not fully configured ` +
        `(INTEGRATION_MODE=${env.INTEGRATION_MODE}); falling back to console.`,
    );
  }
  return new ConsoleCalendarProvider();
}
