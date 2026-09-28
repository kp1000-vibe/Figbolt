'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Modal, useToast } from '@/components/ui/feedback';
import { scheduleMeetingAction, type ActionState } from './actions';

/**
 * Schedule a meeting with a customer.
 *
 * The timezone handling is the part worth reading. The two inputs collect
 * wall-clock time in the browser's zone; the offset goes with them so the
 * server can convert exactly. Sending a naive string and letting the server
 * guess is how a 2pm call ends up in the customer's calendar at 2pm UTC.
 *
 * Defaults are chosen so the common case is nearly zero typing: tomorrow at
 * 10:00 local, thirty minutes.
 */
export function ScheduleMeetingButton({
  accountId,
  opportunityId,
  defaultAttendees,
}: {
  accountId?: string;
  opportunityId?: string;
  defaultAttendees?: string[];
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Schedule meeting
      </Button>
      {open && (
        <ScheduleModal
          onClose={() => setOpen(false)}
          accountId={accountId}
          opportunityId={opportunityId}
          defaultAttendees={defaultAttendees}
        />
      )}
    </>
  );
}

function ScheduleModal({
  onClose,
  accountId,
  opportunityId,
  defaultAttendees,
}: {
  onClose: () => void;
  accountId?: string;
  opportunityId?: string;
  defaultAttendees?: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, setState] = React.useState<ActionState>({ ok: true, message: '' });
  const [pending, setPending] = React.useState(false);

  const defaults = React.useMemo(() => nextWorkingSlot(), []);

  const onSubmit = async (formData: FormData) => {
    setPending(true);
    // The browser knows the offset; the server must not have to guess it.
    // getTimezoneOffset returns minutes to ADD to local to reach UTC.
    formData.set('tzOffsetMinutes', String(new Date().getTimezoneOffset()));

    const result = await scheduleMeetingAction(state, formData);
    setState(result);
    setPending(false);

    if (result.ok) {
      toast({ tone: 'success', title: 'Meeting scheduled', description: result.message });
      router.refresh();
      onClose();
    }
  };

  return (
    <Modal open onClose={onClose} title="Schedule a meeting">
      <form action={onSubmit} className="space-y-4">
        <Field label="Title">
          <Input
            name="title"
            required
            minLength={3}
            maxLength={200}
            placeholder="Discovery call — pricing and security review"
            autoFocus
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" name="date" required defaultValue={defaults.date} />
          </Field>
          <Field label="Time">
            <Input type="time" name="time" required defaultValue={defaults.time} />
          </Field>
          <Field label="Length">
            <Select name="durationMinutes" defaultValue="30">
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60">1 hour</option>
              <option value="90">1.5 hours</option>
            </Select>
          </Field>
        </div>

        <Field
          label="Invite"
          hint="Comma-separated email addresses. You are added as the organiser."
        >
          <Input
            name="attendees"
            required
            placeholder="dana@acme.com, priya@acme.com"
            defaultValue={defaultAttendees?.join(', ')}
          />
        </Field>

        <Field label="Agenda" hint="Shown in the invitation. Optional.">
          <Textarea
            name="description"
            rows={3}
            maxLength={4000}
            placeholder="What we want to cover, and what we will need from them."
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Location" hint="Optional.">
            <Input name="location" maxLength={300} placeholder="Zoom / their office" />
          </Field>
          <Field label="Video link" hint="Leave blank to let the calendar create one.">
            <Input name="meetingUrl" maxLength={500} placeholder="https://…" />
          </Field>
        </div>

        {accountId && <input type="hidden" name="accountId" value={accountId} />}
        {opportunityId && <input type="hidden" name="opportunityId" value={opportunityId} />}

        {!state.ok && state.message && (
          <p className="rounded-[var(--radius-sm)] border border-danger/35 bg-danger-subtle px-3 py-2 text-sm text-danger-text">
            {state.message}
          </p>
        )}

        <p className="text-xs text-text-subtle">
          An invitation is emailed to each attendee. The meeting is linked to the account
          automatically when an address matches a known contact.
        </p>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={onClose} type="button">
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Scheduling…' : 'Schedule and invite'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Tomorrow at 10:00 local, as the two values the date/time inputs want. */
function nextWorkingSlot(): { date: string; time: string } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  // Local parts, not toISOString, which would shift the date across midnight
  // for anyone west of UTC.
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: '10:00',
  };
}
