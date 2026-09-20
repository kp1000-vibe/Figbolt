'use client';

import * as React from 'react';
import { Button, Select } from '@/components/ui/primitives';
import { Modal, Spinner, useToast } from '@/components/ui/feedback';
import { Textarea, Field } from '@/components/ui/primitives';
import { ActionButtons } from '@/components/ai/action-buttons';
import { invokeToolAction, refreshOpportunityMemoryAction } from '@/app/actions';
import { Refresh } from '@/components/layout/icons';

export function DealHeaderActions({
  opportunityId,
  accountId,
  dealName,
  stages,
  currentStageId,
}: {
  opportunityId: string;
  accountId: string;
  dealName: string;
  stages: { id: string; name: string; position: number; type: string }[];
  currentStageId: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [stageModal, setStageModal] = React.useState(false);
  const { toast } = useToast();

  const refresh = async () => {
    setPending(true);
    const result = await refreshOpportunityMemoryAction(opportunityId);
    setPending(false);
    toast(
      result.ok
        ? { title: result.message ?? 'Recomputed.', tone: 'success' }
        : { title: 'Could not recompute', description: result.error, tone: 'error' },
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButtons
          size="sm"
          actions={[
            { label: 'Draft email', kind: 'draft_email', payload: { purpose: 'follow up on this deal' } },
            { label: 'Create task', kind: 'create_task', payload: { title: `Follow up on ${dealName}` } },
          ]}
          context={{ accountId, opportunityId }}
        />
        <Button variant="secondary" size="sm" onClick={() => setStageModal(true)}>
          Change stage
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={pending}
          title="Recompute deal intelligence and health from current evidence"
        >
          {pending ? <Spinner className="size-3.5" /> : <Refresh />}
          Recompute
        </Button>
      </div>

      {stageModal && (
        <StageModal
          opportunityId={opportunityId}
          stages={stages}
          currentStageId={currentStageId}
          onClose={() => setStageModal(false)}
        />
      )}
    </>
  );
}

/**
 * Stage changes require a reason.
 *
 * The reason lands on the timeline event and the audit row, which is what
 * makes "why is this in Negotiation?" answerable three weeks later. A stage
 * move is also a MEDIUM-risk tool call, so it may be held for approval
 * depending on workspace policy.
 */
function StageModal({
  opportunityId,
  stages,
  currentStageId,
  onClose,
}: {
  opportunityId: string;
  stages: { id: string; name: string; type: string }[];
  currentStageId: string;
  onClose: () => void;
}) {
  const current = stages.find((s) => s.id === currentStageId);
  const [stageName, setStageName] = React.useState(
    stages.find((s) => s.id !== currentStageId)?.name ?? '',
  );
  const [reason, setReason] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  const submit = async () => {
    setPending(true);
    const result = await invokeToolAction('change_pipeline_stage', {
      opportunityId,
      stageName,
      reason,
    });
    setPending(false);

    if (result.ok) {
      toast({
        title: result.data?.needsApproval ? 'Queued for approval' : 'Stage updated',
        description: result.data?.needsApproval
          ? 'This workspace holds record changes for review.'
          : undefined,
        tone: 'success',
      });
      onClose();
    } else {
      toast({ title: 'Could not change the stage', description: result.error, tone: 'error' });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Change pipeline stage"
      description={`Currently in ${current?.name ?? 'an unknown stage'}. The reason is recorded on the timeline and in the audit log.`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={pending || !stageName || reason.trim().length < 5}
          >
            {pending && <Spinner className="size-3" />}
            Move deal
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Move to">
          <Select value={stageName} onChange={(e) => setStageName(e.target.value)}>
            {stages
              .filter((s) => s.id !== currentStageId)
              .map((stage) => (
                <option key={stage.id} value={stage.name}>
                  {stage.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field
          label="Why is this moving?"
          hint="At least a sentence. This is what makes the stage history readable later."
        >
          <Textarea
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Security review completed and pricing agreed with the champion."
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  );
}
