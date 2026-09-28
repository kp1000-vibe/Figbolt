'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ctxAssert, requireCtx, ValidationError } from '@/server/context';
import { checkRateLimit } from '@/server/rate-limit';
import { scheduleMeeting } from '@/server/calendar/schedule';
import { importTranscript, transcribeMeeting } from '@/server/meetings/transcribe';
import { proposeMeetingActions } from '@/server/meetings/propose';

/**
 * Meeting actions taken directly by a person.
 *
 * A human clicking "Schedule" in the UI is the authority for that action, so
 * these run without an approval step — unlike the `schedule_meeting` agent
 * tool, which is HIGH risk and queues for review. The permission check is the
 * same `can()` table in both paths; only the consent model differs.
 */

export type ActionState = { ok: boolean; message: string; meetingId?: string };

const scheduleSchema = z.object({
  title: z.string().min(3, 'Give the meeting a title.').max(200),
  date: z.string().min(1, 'Pick a date.'),
  time: z.string().min(1, 'Pick a time.'),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  attendees: z.string().min(3, 'Invite at least one person.'),
  description: z.string().max(4000).optional(),
  location: z.string().max(300).optional(),
  meetingUrl: z.string().max(500).optional(),
  accountId: z.string().optional(),
  opportunityId: z.string().optional(),
  /** Minutes to add to get UTC, from the browser. */
  tzOffsetMinutes: z.coerce.number().int().min(-900).max(900).default(0),
});

export async function scheduleMeetingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'meeting:manage');

  const limit = await checkRateLimit(`schedule:${ctx.workspaceId}`, 40, 3600);
  if (!limit.allowed) {
    return { ok: false, message: 'Too many meetings scheduled in the last hour.' };
  }

  const parsed = scheduleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const input = parsed.data;

  // The form collects wall-clock time in the user's timezone. Converting here,
  // with the offset the browser reported, avoids scheduling a 2pm call for 2pm
  // UTC — which is the single most common bug in this kind of form.
  const local = new Date(`${input.date}T${input.time}:00Z`);
  if (!Number.isFinite(local.getTime())) {
    return { ok: false, message: 'That date and time could not be read.' };
  }
  const startsAt = new Date(local.getTime() + input.tzOffsetMinutes * 60_000);

  const attendeeEmails = input.attendees
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);

  try {
    const result = await scheduleMeeting(ctx, {
      title: input.title,
      description: input.description || undefined,
      startsAt,
      durationMinutes: input.durationMinutes,
      attendeeEmails,
      location: input.location || undefined,
      meetingUrl: input.meetingUrl || undefined,
      accountId: input.accountId || undefined,
      opportunityId: input.opportunityId || undefined,
    });

    revalidatePath('/meetings');

    const who = result.attendees.join(', ');

    // Only claim an invitation went out when a provider that actually delivers
    // accepted it. In console mode the meeting is recorded and nothing is sent,
    // and saying otherwise would have a rep waiting on a reply that cannot come.
    let message: string;
    if (result.inviteStatus === 'failed') {
      message = `Saved the meeting, but the invitation failed: ${result.error ?? 'unknown error'}`;
    } else if (result.delivered && result.emailDelivered) {
      message = `Scheduled in your ${result.provider} calendar and emailed to ${who}.`;
    } else if (result.delivered) {
      message = `Added to your ${result.provider} calendar. ${who} invited.`;
    } else if (result.emailDelivered) {
      message = `Scheduled. An invitation was emailed to ${who}.`;
    } else {
      message =
        `Meeting recorded, but nothing was sent — the calendar and email providers are ` +
        `in console mode. Set CALENDAR_PROVIDER and EMAIL_PROVIDER to invite ${who} for real.`;
    }

    return { ok: true, meetingId: result.meetingId, message };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, message: err.message };
    console.error('[meetings] schedule failed:', err);
    return { ok: false, message: 'Could not schedule that meeting.' };
  }
}

export async function transcribeMeetingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'record:update');

  const meetingId = String(formData.get('meetingId') ?? '');
  if (!meetingId) return { ok: false, message: 'Missing meeting.' };

  const limit = await checkRateLimit(`transcribe:${ctx.workspaceId}`, 20, 3600);
  if (!limit.allowed) return { ok: false, message: 'Too many transcription jobs this hour.' };

  try {
    const pasted = String(formData.get('transcript') ?? '').trim();
    const result = pasted
      ? await importTranscript(ctx, meetingId, pasted)
      : await transcribeMeeting(ctx, meetingId);

    revalidatePath(`/meetings/${meetingId}`);
    return {
      ok: true,
      meetingId,
      message: `Transcribed ${result.segmentCount} segments via ${result.provider}. Summary extracted.`,
    };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, message: err.message };
    console.error('[meetings] transcription failed:', err);
    return { ok: false, message: 'Transcription failed.' };
  }
}

export async function proposeActionsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'record:create');

  const meetingId = String(formData.get('meetingId') ?? '');
  if (!meetingId) return { ok: false, message: 'Missing meeting.' };

  try {
    const result = await proposeMeetingActions(ctx, meetingId, {
      force: formData.get('force') === 'true',
    });

    revalidatePath(`/meetings/${meetingId}`);

    if (result.alreadyProposed) {
      return { ok: true, meetingId, message: 'Actions were already proposed for this meeting.' };
    }
    if (result.proposed.length === 0) {
      const why = result.rejected.length
        ? ` (${result.rejected.length} suggestion(s) failed validation and were discarded)`
        : '';
      return { ok: true, meetingId, message: `Nothing to propose from this meeting${why}.` };
    }

    return {
      ok: true,
      meetingId,
      message: `${result.proposed.length} action(s) queued for your approval.`,
    };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, message: err.message };
    console.error('[meetings] proposing actions failed:', err);
    return { ok: false, message: 'Could not propose actions.' };
  }
}
