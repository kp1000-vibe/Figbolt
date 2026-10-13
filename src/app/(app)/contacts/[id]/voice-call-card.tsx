'use client';

import * as React from 'react';
import { useActionState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives';
import { openingLine } from '@/lib/voice/script';
import { relativeTime } from '@/lib/utils';
import { placeCallAction, type CallActionState } from './call-actions';

type RecentCall = {
  id: string;
  purpose: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  durationSeconds: number | null;
  meetingId: string | null;
  error: string | null;
  createdAt: Date;
};

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  placing: { label: 'Placing', tone: 'accent' },
  queued: { label: 'Dialling', tone: 'accent' },
  in_progress: { label: 'On the call', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  no_answer: { label: 'No answer', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  not_placed: { label: 'Not dialled', tone: 'warning' },
};

/**
 * Have the voice agent call this contact. The exact opening line is shown,
 * live, before anything happens. It is built by the same function the server
 * uses, so what you approve is what is said.
 */
export function VoiceCallCard(props: {
  contactId: string;
  contactFirstName: string | null;
  businessName: string;
  callerName: string | null;
  canCall: { ok: true } | { ok: false; reason: string };
  live: boolean;
  calls: RecentCall[];
}) {
  const [state, action, pending] = useActionState<CallActionState, FormData>(placeCallAction, {});
  const [purpose, setPurpose] = React.useState('');
  const [record, setRecord] = React.useState(false);
  const [consent, setConsent] = React.useState(false);

  const preview = openingLine({
    callerName: props.callerName,
    businessName: props.businessName,
    contactFirstName: props.contactFirstName,
    purpose: purpose || 'the reason for your call',
    recordCall: record,
  });

  const field =
    'mt-1 w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base text-text sm:text-sm';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice agent</CardTitle>
        {!props.live && <Badge tone="warning">Test mode</Badge>}
      </CardHeader>
      <CardBody className="pt-0">
        {!props.canCall.ok ? (
          <p className="text-xs text-text-muted text-pretty">{props.canCall.reason}</p>
        ) : (
          <form action={action} className="space-y-3">
            <input type="hidden" name="contactId" value={props.contactId} />
            <label className="block">
              <span className="text-2xs font-medium text-text-muted">Why are you calling?</span>
              <input
                name="purpose"
                required
                minLength={5}
                maxLength={300}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Checking in on the proposal we sent last week"
                className={`${field} h-9`}
              />
            </label>
            <label className="block">
              <span className="text-2xs font-medium text-text-muted">Points to cover (one per line, optional)</span>
              <textarea name="talkingPoints" rows={3} className={`${field} py-2`} />
            </label>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              Up to
              <select
                name="maxMinutes"
                defaultValue="5"
                className="h-8 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 text-base sm:text-sm"
              >
                <option value="3">3</option>
                <option value="5">5</option>
                <option value="10">10</option>
              </select>
              minutes
            </label>

            <div className="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-2.5">
              <p className="text-3xs font-medium uppercase tracking-[0.12em] text-text-subtle">It will open with</p>
              <p className="mt-1 text-xs leading-relaxed text-text text-pretty">&ldquo;{preview}&rdquo;</p>
            </div>

            <label className="flex min-h-6 items-start gap-2 text-xs text-text">
              <input
                type="checkbox"
                name="recordCall"
                checked={record}
                onChange={(e) => setRecord(e.target.checked)}
                className="mt-0.5 size-4"
              />
              They agreed to be recorded
            </label>
            <label className="flex min-h-6 items-start gap-2 text-xs text-text">
              <input
                type="checkbox"
                name="consentConfirmed"
                required
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 size-4"
              />
              <span className="text-pretty">
                {props.contactFirstName ?? 'This person'} agreed to receive calls from us. AI voice calls need prior
                consent.
              </span>
            </label>

            <Button type="submit" size="sm" disabled={pending || !consent || purpose.trim().length < 5}>
              {pending ? 'Placing…' : props.live ? 'Place call' : 'Place test call'}
            </Button>
            {!props.live && (
              <p className="text-2xs text-text-subtle text-pretty">
                No voice provider is set up, so the call is recorded but nobody is phoned.
              </p>
            )}
            {state.message && (
              <p className={state.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'} role="status">
                {state.message}
              </p>
            )}
          </form>
        )}

        {props.calls.length > 0 && (
          <ul className="mt-4 space-y-2.5 border-t border-border pt-3">
            {props.calls.map((call) => {
              const s = STATUS[call.status] ?? { label: call.status, tone: 'neutral' as const };
              return (
                <li key={call.id} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-text">{call.purpose}</span>
                    <Badge tone={call.outcome === 'do_not_call' ? 'danger' : s.tone} size="sm">
                      {call.outcome === 'do_not_call' ? 'Asked not to call' : s.label}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    {relativeTime(call.createdAt)}
                    {call.durationSeconds != null && ` · ${Math.max(1, Math.round(call.durationSeconds / 60))} min`}
                  </p>
                  {call.summary && <p className="mt-1 text-text-muted text-pretty">{call.summary}</p>}
                  {call.error && <p className="mt-1 text-danger-text">{call.error}</p>}
                  {call.meetingId && (
                    <Link
                      href={`/meetings/${call.meetingId}`}
                      className="mt-1 inline-flex min-h-6 items-center text-accent-text hover:underline"
                    >
                      Transcript
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
