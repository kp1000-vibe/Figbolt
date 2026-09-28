import { and, eq } from 'drizzle-orm';
import { contacts, meetingParticipants, meetings, users } from '@/db/schema';
import { env } from '@/lib/env';
import { scope, ValidationError, type Ctx } from '../context';
import { record } from '../audit';
import { addActivity, addTimelineEvent } from '../memory/timeline';
import { resolveParties } from '../memory/ingest';
import { buildIcs, icsUid, type IcsAttendee } from './ics';
import { getCalendarProvider, type CalendarAuth } from './providers';

/**
 * Scheduling a meeting with a customer.
 *
 * The ordering here is the important part, and it mirrors outbound email: the
 * **meeting row is written before any provider call**, so "what did we commit
 * to?" is answerable from our own data even when Google or Microsoft is down,
 * and a failed invite leaves a visible failed row rather than nothing at all.
 *
 *   1. validate and resolve who this is with
 *   2. write meetings + meeting_participants          (durable intent)
 *   3. create the event on the organiser's calendar   (best effort)
 *   4. email the .ics invitation                      (best effort)
 *   5. record audit, activity and timeline
 *
 * Steps 3 and 4 are independent. With CALENDAR_PROVIDER=console step 3 is a
 * no-op but step 4 still produces a genuine RFC 5545 invitation the customer
 * can accept, so the feature is useful before any OAuth app exists.
 *
 * This function does not decide *whether* the meeting may be scheduled. It is
 * called either by a human acting directly in the UI, or by the agent tool
 * `schedule_meeting`, which is HIGH risk and therefore approval-gated. Sending
 * a customer a calendar invitation is not something an agent gets to do alone.
 */

export type ScheduleMeetingInput = {
  title: string;
  description?: string;
  startsAt: Date;
  durationMinutes: number;
  /** Customer-side invitees. Internal attendees are added from `organizerId`. */
  attendeeEmails: string[];
  location?: string;
  /** An existing conferencing link. Omit to let the provider create one. */
  meetingUrl?: string;
  accountId?: string;
  opportunityId?: string;
  /** Defaults to the acting user. */
  organizerId?: string;
  /** Skip the invitation email (the event alone is enough). */
  skipInviteEmail?: boolean;
};

export type ScheduleMeetingResult = {
  meetingId: string;
  startsAt: Date;
  endsAt: Date;
  inviteStatus: 'sent' | 'failed' | 'none';
  provider: string;
  /** True when an event reached a real calendar. */
  delivered: boolean;
  /** True when the invitation email was actually handed to a sending provider. */
  emailDelivered: boolean;
  /** Which email provider handled it, so the caller can say so truthfully. */
  emailProvider: string | null;
  eventId: string | null;
  meetingUrl: string | null;
  attendees: string[];
  /** Populated when the invite could not be delivered. */
  error?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTENDEES = 25;
const MIN_MINUTES = 5;
const MAX_MINUTES = 8 * 60;

export async function scheduleMeeting(
  ctx: Ctx,
  input: ScheduleMeetingInput,
): Promise<ScheduleMeetingResult> {
  // ── 1. Validate ──────────────────────────────────────────────────────────
  const title = input.title.trim();
  if (title.length < 3) throw new ValidationError('A meeting needs a title.');

  if (!Number.isFinite(input.startsAt.getTime())) {
    throw new ValidationError('The start time is not a valid date.');
  }
  if (input.durationMinutes < MIN_MINUTES || input.durationMinutes > MAX_MINUTES) {
    throw new ValidationError(
      `A meeting must be between ${MIN_MINUTES} minutes and ${MAX_MINUTES / 60} hours long.`,
    );
  }
  // A meeting scheduled into the past cannot be attended and is almost always a
  // timezone bug in the caller. One minute of slack absorbs clock skew.
  if (input.startsAt.getTime() < Date.now() - 60_000) {
    throw new ValidationError('That start time is in the past.');
  }

  const attendeeEmails = [
    ...new Set(input.attendeeEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  if (attendeeEmails.length === 0) {
    throw new ValidationError('Invite at least one person.');
  }
  if (attendeeEmails.length > MAX_ATTENDEES) {
    throw new ValidationError(`At most ${MAX_ATTENDEES} attendees.`);
  }
  const malformed = attendeeEmails.filter((e) => !EMAIL_RE.test(e));
  if (malformed.length > 0) {
    throw new ValidationError(`Not a valid email address: ${malformed.join(', ')}`);
  }

  const endsAt = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);

  // ── 2. Resolve who this is with ──────────────────────────────────────────
  const organizerId = input.organizerId ?? ctx.userId;
  const [organizer] = organizerId
    ? await ctx.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, organizerId))
        .limit(1)
    : [];

  if (!organizer) throw new ValidationError('Could not identify the meeting organiser.');

  const parties = await resolveParties(ctx, attendeeEmails, {
    accountId: input.accountId ?? null,
    opportunityId: input.opportunityId ?? null,
  });

  const known = await ctx.db
    .select({
      id: contacts.id,
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contacts)
    .where(scope(ctx, contacts));
  const contactByEmail = new Map(
    known
      .filter((c) => c.email)
      .map((c) => [
        c.email!.toLowerCase(),
        { id: c.id, name: `${c.firstName} ${c.lastName}`.trim() },
      ]),
  );

  // ── 3. Write the meeting before anything leaves the building ─────────────
  const [meeting] = await ctx.db
    .insert(meetings)
    .values({
      workspaceId: ctx.workspaceId,
      title,
      description: input.description ?? null,
      startsAt: input.startsAt,
      endsAt,
      location: input.location ?? null,
      meetingUrl: input.meetingUrl ?? null,
      status: 'scheduled',
      origin: 'scheduled_in_figbolt',
      inviteStatus: 'pending',
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      organizerId: organizer.id,
      participantEmails: [organizer.email, ...attendeeEmails].filter(Boolean) as string[],
      transcriptionStatus: 'none',
    })
    .returning();

  const meetingId = meeting!.id;

  await ctx.db.insert(meetingParticipants).values([
    {
      workspaceId: ctx.workspaceId,
      meetingId,
      userId: organizer.id,
      email: organizer.email,
      name: organizer.name,
      isOrganizer: true,
      attended: false,
    },
    ...attendeeEmails.map((email) => ({
      workspaceId: ctx.workspaceId,
      meetingId,
      contactId: contactByEmail.get(email)?.id ?? null,
      email,
      name: contactByEmail.get(email)?.name ?? null,
      isOrganizer: false,
      attended: false,
    })),
  ]);

  // ── 4. Build the invitation ──────────────────────────────────────────────
  const icsAttendees: IcsAttendee[] = attendeeEmails.map((email) => ({
    email,
    name: contactByEmail.get(email)?.name ?? undefined,
  }));

  const event = {
    uid: icsUid(meetingId),
    title,
    description: input.description,
    location: input.location,
    meetingUrl: input.meetingUrl,
    startsAt: input.startsAt,
    endsAt,
    organizer: { email: organizer.email, name: organizer.name ?? undefined },
    attendees: icsAttendees,
    method: 'REQUEST' as const,
  };

  // ── 5. Best-effort delivery ──────────────────────────────────────────────
  const provider = getCalendarProvider();
  let eventId: string | null = null;
  let meetingUrl: string | null = input.meetingUrl ?? null;
  let failure: string | null = null;

  if (provider.delivers) {
    const auth = await organiserCalendarAuth(ctx);
    if (!auth) {
      failure = `No connected ${provider.name} calendar for the organiser.`;
    } else {
      try {
        const created = await provider.createEvent(event, auth);
        eventId = created.eventId;
        meetingUrl = created.meetingUrl ?? meetingUrl;
      } catch (err) {
        failure = (err as Error).message.slice(0, 400);
      }
    }
  }

  // The .ics goes out regardless of whether the API call worked: a customer
  // with an invitation in their inbox is the outcome that matters, and it is
  // the only path that exists at all in console mode.
  // `queued` means the outbox row was written; `emailDelivered` means a
  // provider that actually sends accepted it. Conflating the two is how a UI
  // ends up telling someone an invitation went out when EMAIL_PROVIDER is
  // still `console` and nothing left the machine.
  let queued = false;
  let emailDelivered = false;
  let emailProvider: string | null = null;

  if (!input.skipInviteEmail) {
    try {
      const sent = await sendInvitationEmail(ctx, {
        meetingId,
        event: { ...event, meetingUrl: meetingUrl ?? undefined },
        organizerEmail: organizer.email,
        accountId: parties.accountId,
        opportunityId: parties.opportunityId,
      });
      queued = true;
      emailDelivered = sent.delivered;
      emailProvider = sent.provider;
    } catch (err) {
      failure ??= (err as Error).message.slice(0, 400);
    }
  }

  // `sent` is reserved for something a customer could actually receive.
  const reachedSomeone = Boolean(eventId) || emailDelivered;
  const recordedOnly = queued && !reachedSomeone;
  const inviteStatus: 'sent' | 'failed' | 'none' =
    reachedSomeone ? 'sent' : recordedOnly || input.skipInviteEmail ? 'none' : 'failed';

  if (recordedOnly && !failure) {
    // Not an error, but it must not look like a delivery either.
    failure =
      `Recorded only: calendar provider is "${provider.name}" and email provider is ` +
      `"${emailProvider ?? 'none'}", neither of which delivers.`;
  }

  await ctx.db
    .update(meetings)
    .set({
      inviteStatus,
      inviteProvider: provider.name,
      // Only stamped when something actually reached a person.
      inviteSentAt: reachedSomeone ? new Date() : null,
      inviteError: failure,
      externalEventId: eventId,
      meetingUrl,
    })
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));

  // ── 6. Trail ─────────────────────────────────────────────────────────────
  await record(ctx, {
    action: 'meeting.scheduled',
    resourceType: 'meeting',
    resourceId: meetingId,
    riskLevel: 'high',
    metadata: {
      title,
      startsAt: input.startsAt.toISOString(),
      attendees: attendeeEmails,
      provider: provider.name,
      calendarEventCreated: Boolean(eventId),
      emailDelivered,
      emailProvider,
      inviteStatus,
      ...(failure ? { error: failure } : {}),
    },
  });

  await addActivity(ctx, {
    type: 'meeting',
    subjectType: 'account',
    subjectId: parties.accountId ?? meetingId,
    accountId: parties.accountId,
    opportunityId: parties.opportunityId,
    title: `Scheduled: ${title}`,
    summary: `${input.startsAt.toISOString()} with ${attendeeEmails.join(', ')}`,
    direction: 'outbound',
    occurredAt: new Date(),
    sourceType: 'meeting',
    sourceId: meetingId,
  });

  if (parties.accountId) {
    await addTimelineEvent(ctx, {
      type: 'meeting_scheduled',
      subjectType: 'account',
      subjectId: parties.accountId,
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      title: `Meeting scheduled — ${title}`,
      body: `${input.startsAt.toISOString()} with ${attendeeEmails.join(', ')}`,
      occurredAt: new Date(),
      sourceType: 'meeting',
      sourceId: meetingId,
    });
  }

  return {
    meetingId,
    startsAt: input.startsAt,
    endsAt,
    inviteStatus,
    provider: provider.name,
    delivered: Boolean(eventId),
    emailDelivered,
    emailProvider,
    eventId,
    meetingUrl,
    attendees: attendeeEmails,
    ...(failure ? { error: failure } : {}),
  };
}

/**
 * The organiser's calendar credentials.
 *
 * Returns null rather than throwing when nothing is connected — an unconnected
 * calendar is an ordinary state, not an error, and the .ics path still works.
 */
async function organiserCalendarAuth(ctx: Ctx): Promise<CalendarAuth | null> {
  const provider = env.CALENDAR_PROVIDER === 'microsoft' ? 'outlook_calendar' : 'google_calendar';
  // freshAccessToken refreshes an expired grant before handing it back. A
  // token minted this morning would otherwise fail on an afternoon booking,
  // and the failure would look like "the calendar is not connected".
  const { freshAccessToken } = await import('../integrations/oauth');
  const accessToken = await freshAccessToken(ctx, provider);
  if (!accessToken) return null;
  return { accessToken };
}

/**
 * Email the invitation, with the .ics as a calendar part.
 *
 * Routed through the normal outbound path so the message lands in
 * `email_outbox` and on the account timeline like any other customer email —
 * an invitation is a thing we sent a customer, and it should be as auditable
 * as the rest.
 */
async function sendInvitationEmail(
  ctx: Ctx,
  args: {
    meetingId: string;
    event: Parameters<typeof buildIcs>[0];
    organizerEmail: string;
    accountId: string | null;
    opportunityId: string | null;
  },
): Promise<{ delivered: boolean; provider: string }> {
  const { sendEmail } = await import('../email/send');
  const ics = buildIcs(args.event);

  const when = args.event.startsAt.toUTCString();
  const bodyLines = [
    `You are invited to: ${args.event.title}`,
    '',
    `When: ${when} (${Math.round(
      (args.event.endsAt.getTime() - args.event.startsAt.getTime()) / 60_000,
    )} minutes)`,
  ];
  if (args.event.location) bodyLines.push(`Where: ${args.event.location}`);
  if (args.event.meetingUrl) bodyLines.push(`Join: ${args.event.meetingUrl}`);
  if (args.event.description) bodyLines.push('', args.event.description);
  bodyLines.push('', 'A calendar invitation is attached.');

  const result = await sendEmail(ctx, {
    to: args.event.attendees.map((a) => a.email),
    subject: `Invitation: ${args.event.title} — ${when}`,
    body: bodyLines.join('\n'),
    accountId: args.accountId ?? undefined,
    opportunityId: args.opportunityId ?? undefined,
    attachments: [
      {
        filename: 'invite.ics',
        contentType: 'text/calendar; method=REQUEST; charset=utf-8',
        content: ics,
      },
    ],
  });

  return { delivered: result.delivered, provider: result.provider };
}
