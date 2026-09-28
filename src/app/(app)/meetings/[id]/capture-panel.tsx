'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/feedback';
import {
  proposeActionsAction,
  transcribeMeetingAction,
  type ActionState,
} from '../actions';

/**
 * Capture and follow-through for one meeting.
 *
 * The two halves are the loop the product is selling: get the words in, then
 * turn them into CRM changes a human signs off. Both are shown even when
 * empty, because the absence of a transcript is the thing a rep needs to
 * notice, and hiding the panel would make it invisible.
 */

export type ProposedRow = {
  id: string;
  tool: string;
  title: string;
  rationale: string | null;
  status: string;
  riskLevel: string;
};

export function CapturePanel({
  meetingId,
  hasTranscript,
  hasIntelligence,
  transcriptionStatus,
  transcriptionError,
  transcriptionAvailable,
  actionsProposed,
  proposals,
}: {
  meetingId: string;
  hasTranscript: boolean;
  hasIntelligence: boolean;
  transcriptionStatus: string;
  transcriptionError: string | null;
  transcriptionAvailable: boolean;
  actionsProposed: boolean;
  proposals: ProposedRow[];
}) {
  return (
    <div className="space-y-5">
      {!hasTranscript && (
        <TranscriptCapture
          meetingId={meetingId}
          status={transcriptionStatus}
          error={transcriptionError}
          canAutoTranscribe={transcriptionAvailable}
        />
      )}

      <ProposedActions
        meetingId={meetingId}
        hasIntelligence={hasIntelligence}
        actionsProposed={actionsProposed}
        proposals={proposals}
      />
    </div>
  );
}

function TranscriptCapture({
  meetingId,
  status,
  error,
  canAutoTranscribe,
}: {
  meetingId: string;
  status: string;
  error: string | null;
  canAutoTranscribe: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);
  const [showPaste, setShowPaste] = React.useState(false);

  const run = async (formData: FormData) => {
    setPending(true);
    const result: ActionState = await transcribeMeetingAction({ ok: true, message: '' }, formData);
    setPending(false);
    toast({
      tone: result.ok ? 'success' : 'error',
      title: result.ok ? 'Transcript captured' : 'Could not transcribe',
      description: result.message,
    });
    if (result.ok) {
      setShowPaste(false);
      router.refresh();
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">Transcript</CardTitle>
          {status !== 'none' && (
            <Badge tone={status === 'done' ? 'success' : status === 'failed' ? 'danger' : 'neutral'}>
              {status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardBody className="pt-0">
        <p className="text-sm text-text-muted text-pretty">
          Everything below this meeting — the summary, the objections, the next steps — is
          derived from a transcript. Without one there is nothing to extract from.
        </p>

        {error && (
          <p className="mt-3 rounded-[var(--radius-sm)] border border-danger/35 bg-danger-subtle px-3 py-2 text-2xs text-danger-text">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {canAutoTranscribe && (
            <form action={run}>
              <input type="hidden" name="meetingId" value={meetingId} />
              <Button type="submit" variant="primary" size="sm" disabled={pending}>
                {pending ? 'Transcribing…' : 'Transcribe the recording'}
              </Button>
            </form>
          )}
          <Button size="sm" onClick={() => setShowPaste((v) => !v)}>
            {showPaste ? 'Cancel' : 'Paste a transcript'}
          </Button>
        </div>

        {!canAutoTranscribe && (
          <p className="mt-2 text-2xs text-text-subtle text-pretty">
            Automatic transcription is switched off. Set TRANSCRIPTION_PROVIDER to enable it, or
            paste a transcript from your notetaker — both take the same path from here.
          </p>
        )}

        {showPaste && (
          <form action={run} className="mt-4 border-t border-border pt-4">
            <input type="hidden" name="meetingId" value={meetingId} />
            <Field
              label="Transcript"
              hint={'One line per turn, as "Name: what they said". Unrecognised speakers are treated as the customer.'}
            >
              <Textarea
                name="transcript"
                rows={8}
                required
                minLength={20}
                placeholder={'Dana Whitfield: Thanks for making time.\nAlex Rivera: Of course — shall we start with the security review?'}
              />
            </Field>
            <div className="mt-3 flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={pending}>
                {pending ? 'Processing…' : 'Save and extract'}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function ProposedActions({
  meetingId,
  hasIntelligence,
  actionsProposed,
  proposals,
}: {
  meetingId: string;
  hasIntelligence: boolean;
  actionsProposed: boolean;
  proposals: ProposedRow[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);

  const propose = async (formData: FormData) => {
    setPending(true);
    const result: ActionState = await proposeActionsAction({ ok: true, message: '' }, formData);
    setPending(false);
    toast({
      tone: result.ok ? 'success' : 'error',
      title: result.ok ? 'Proposed' : 'Could not propose actions',
      description: result.message,
    });
    if (result.ok) router.refresh();
  };

  const pendingCount = proposals.filter((p) => p.status === 'pending').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">CRM actions</CardTitle>
          {pendingCount > 0 && <Badge tone="warning">{pendingCount} awaiting you</Badge>}
        </div>
      </CardHeader>
      <CardBody className="pt-0">
        {proposals.length === 0 ? (
          <>
            <p className="text-sm text-text-muted text-pretty">
              Turn what was agreed into real CRM changes: the summary logged on the account, a
              task for each commitment, and a follow-up email drafted. Nothing is applied until
              you approve it.
            </p>
            {hasIntelligence ? (
              <form action={propose} className="mt-4">
                <input type="hidden" name="meetingId" value={meetingId} />
                {actionsProposed && <input type="hidden" name="force" value="true" />}
                <Button type="submit" variant="primary" size="sm" disabled={pending}>
                  {pending
                    ? 'Working…'
                    : actionsProposed
                      ? 'Propose again'
                      : 'Propose actions from this meeting'}
                </Button>
              </form>
            ) : (
              <p className="mt-3 text-2xs text-text-subtle">
                Waiting on a summary — capture a transcript first.
              </p>
            )}
          </>
        ) : (
          <>
            <ul className="space-y-2.5">
              {proposals.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-3 rounded-[var(--radius-sm)] border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-text text-pretty">{p.title}</p>
                    {p.rationale && (
                      <p className="mt-0.5 text-2xs text-text-muted text-pretty">{p.rationale}</p>
                    )}
                    <p className="mt-1 font-mono text-2xs text-text-subtle">{p.tool}</p>
                  </div>
                  <Badge
                    tone={
                      p.status === 'executed'
                        ? 'success'
                        : p.status === 'rejected'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {p.status}
                  </Badge>
                </li>
              ))}
            </ul>
            {pendingCount > 0 && (
              <Link
                href="/agents"
                className="mt-3 inline-block text-2xs text-accent-text hover:underline"
              >
                Review them in the approval queue →
              </Link>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
