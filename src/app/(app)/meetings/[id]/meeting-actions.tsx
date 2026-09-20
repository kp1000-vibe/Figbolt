'use client';

import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { Modal, Spinner, useToast } from '@/components/ui/feedback';
import { Field, Input, Textarea } from '@/components/ui/primitives';
import { ActionButtons } from '@/components/ai/action-buttons';
import { invokeToolAction } from '@/app/actions';
import { Mail, Refresh } from '@/components/layout/icons';

/**
 * Meeting actions.
 *
 * "Reprocess" re-runs the memory engine over the stored transcript, which is
 * the honest way to recover from an extraction bug: the raw source is
 * untouched, so re-deriving is always safe and always reproducible.
 */
export function MeetingActions({
  meetingId,
  accountId,
  opportunityId,
  hasTranscript,
  followUp,
}: {
  meetingId: string;
  accountId: string | null;
  opportunityId: string | null;
  hasTranscript: boolean;
  followUp: { subject: string; body: string } | null;
}) {
  const [pending, setPending] = React.useState(false);
  const [draft, setDraft] = React.useState<{ subject: string; body: string } | null>(null);
  const { toast } = useToast();

  const reprocess = async () => {
    setPending(true);
    try {
      const res = await fetch('/api/meetings/reprocess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingId }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast({
        title: 'Meeting reprocessed',
        description: 'Summary, commitments, objections and signals were re-derived from the transcript.',
        tone: 'success',
      });
      window.location.reload();
    } catch {
      toast({ title: 'Could not reprocess this meeting', tone: 'error' });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {followUp && (
          <Button variant="secondary" size="sm" onClick={() => setDraft(followUp)}>
            <Mail />
            Review follow-up
          </Button>
        )}

        <ActionButtons
          size="sm"
          actions={[
            { label: 'Draft follow-up', kind: 'draft_email', payload: { purpose: 'meeting follow-up' } },
            { label: 'Create task', kind: 'create_task', payload: {} },
          ]}
          context={{ accountId, opportunityId }}
        />

        {hasTranscript && (
          <Button
            variant="ghost"
            size="sm"
            onClick={reprocess}
            disabled={pending}
            title="Re-run extraction over the stored transcript"
          >
            {pending ? <Spinner className="size-3.5" /> : <Refresh />}
            Reprocess
          </Button>
        )}
      </div>

      {draft && (
        <FollowUpModal
          draft={draft}
          accountId={accountId}
          opportunityId={opportunityId}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  );
}

function FollowUpModal({
  draft,
  accountId,
  opportunityId,
  onClose,
}: {
  draft: { subject: string; body: string };
  accountId: string | null;
  opportunityId: string | null;
  onClose: () => void;
}) {
  const [to, setTo] = React.useState('');
  const [subject, setSubject] = React.useState(draft.subject);
  const [body, setBody] = React.useState(draft.body);
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  const save = async () => {
    setPending(true);
    const result = await invokeToolAction('draft_email', {
      to: to.split(/\s*,\s*/).filter(Boolean),
      subject,
      body,
      accountId,
      opportunityId,
    });
    setPending(false);

    if (result.ok) {
      toast({
        title: 'Draft saved',
        description: 'Nothing has been sent. Sending is a separate approval.',
        tone: 'success',
      });
      onClose();
    } else {
      toast({ title: 'Could not save the draft', description: result.error, tone: 'error' });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Follow-up draft"
      description="Prepared from this meeting's commitments and next steps. Saved as a draft — sending requires approval."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Discard
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={pending || !to.trim() || !subject.trim()}
          >
            {pending && <Spinner className="size-3" />}
            Save draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="To" hint="Comma-separated.">
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="dana.whitfield@acme.com"
            autoFocus
          />
        </Field>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Body">
          <Textarea
            rows={16}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="font-mono text-xs leading-relaxed"
          />
        </Field>
      </div>
    </Modal>
  );
}
