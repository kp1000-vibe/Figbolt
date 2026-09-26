'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@/components/ui/feedback';
import { Modal, Spinner } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { createTaskAction, invokeToolAction } from '@/app/actions';
import { ArrowRight, Mail, Plus } from '@/components/layout/icons';

/**
 * Buttons that turn an AI recommendation into a real action.
 *
 * Each one routes through a server action which routes through the agent tool
 * dispatcher, so a recommendation a human accepts gets the same permission
 * check, approval gate and audit row as one an agent proposes. Drafting an
 * email opens the composer pre-filled rather than sending anything — the
 * approval step is a feature, not a formality.
 */

export type RecommendedActionSpec = {
  label: string;
  kind: string;
  payload?: Record<string, unknown>;
};

export function ActionButtons({
  actions,
  context,
  size = 'sm',
}: {
  actions: RecommendedActionSpec[];
  context?: { accountId?: string | null; opportunityId?: string | null; contactId?: string | null };
  size?: 'xs' | 'sm';
}) {
  const [taskModal, setTaskModal] = React.useState<{ title: string; payload: Record<string, unknown> } | null>(null);
  const [draftModal, setDraftModal] = React.useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  if (actions.length === 0) return null;

  const run = async (action: RecommendedActionSpec) => {
    const payload: Record<string, unknown> = { ...context, ...action.payload };

    if (action.kind === 'create_task') {
      setTaskModal({
        title: String(payload['title'] ?? ''),
        payload,
      });
      return;
    }

    if (action.kind === 'draft_email') {
      setDraftModal(payload);
      return;
    }

    if (action.kind === 'open_record') {
      const type = String(payload['type'] ?? '');
      const id = String(payload['id'] ?? '');
      const path =
        type === 'opportunity'
          ? `/opportunities/${id}`
          : type === 'account'
            ? `/accounts/${id}`
            : type === 'contact'
              ? `/contacts/${id}`
              : type === 'automation'
                ? `/automations`
                : null;
      if (path) router.push(path);
      else toast({ title: 'Nothing to open for that record type.', tone: 'info' });
      return;
    }

    if (action.kind === 'open_approval') {
      router.push('/inbox?section=agent_approval');
      return;
    }

    if (action.kind === 'open_run') {
      toast({ title: 'Open the agent to see the run.', tone: 'info' });
      router.push('/agents');
      return;
    }

    if (action.kind === 'schedule_meeting') {
      toast({
        title: 'Calendar not connected',
        description:
          'Connect Google or Microsoft Calendar in Integrations to schedule from Figbolt. In demo mode the connector runs read-only.',
        tone: 'info',
      });
      return;
    }

    // Anything else is treated as a tool name.
    setBusy(action.kind);
    const result = await invokeToolAction(action.kind, payload);
    setBusy(null);
    toast(
      result.ok
        ? { title: result.message ?? 'Done.', tone: 'success' }
        : { title: 'Could not complete that', description: result.error, tone: 'error' },
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((action, i) => (
          <Button
            key={`${action.kind}-${i}`}
            variant={i === 0 ? 'secondary' : 'ghost'}
            size={size}
            onClick={() => run(action)}
            disabled={busy === action.kind}
          >
            {busy === action.kind && <Spinner className="size-3" />}
            {action.kind === 'draft_email' && <Mail />}
            {action.kind === 'create_task' && <Plus />}
            {action.label}
            {action.kind === 'open_record' && <ArrowRight />}
          </Button>
        ))}
      </div>

      {taskModal && (
        <CreateTaskModal
          initialTitle={taskModal.title}
          payload={taskModal.payload}
          onClose={() => setTaskModal(null)}
        />
      )}
      {draftModal && <DraftEmailModal payload={draftModal} onClose={() => setDraftModal(null)} />}
    </>
  );
}

function CreateTaskModal({
  initialTitle,
  payload,
  onClose,
}: {
  initialTitle: string;
  payload: Record<string, unknown>;
  onClose: () => void;
}) {
  const [title, setTitle] = React.useState(initialTitle);
  const [priority, setPriority] = React.useState('high');
  const [dueInDays, setDueInDays] = React.useState('2');
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  const submit = async () => {
    setPending(true);
    const result = await createTaskAction({
      title,
      priority,
      dueInDays: Number(dueInDays),
      accountId: payload['accountId'] as string | undefined,
      opportunityId: payload['opportunityId'] as string | undefined,
      contactId: payload['contactId'] as string | undefined,
      commitmentId: payload['commitmentId'] as string | undefined,
    });
    setPending(false);

    if (result.ok) {
      toast({ title: result.message ?? 'Task created.', tone: 'success' });
      onClose();
    } else {
      toast({ title: 'Could not create the task', description: result.error, tone: 'error' });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Create task"
      description="Tasks are internal. Nothing is sent to the customer."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={pending || title.trim().length < 3}
          >
            {pending && <Spinner className="size-3" />}
            Create task
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
          </Field>
          <Field label="Due in (days)">
            <Input
              type="number"
              min={0}
              max={365}
              value={dueInDays}
              onChange={(e) => setDueInDays(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function DraftEmailModal({
  payload,
  onClose,
}: {
  payload: Record<string, unknown>;
  onClose: () => void;
}) {
  const [state, setState] = React.useState<
    { phase: 'loading' } | { phase: 'ready'; to: string; subject: string; body: string } | { phase: 'error'; error: string }
  >({ phase: 'loading' });
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { to: string[]; subject: string; body: string };
        setState({
          phase: 'ready',
          to: data.to.join(', '),
          subject: data.subject,
          body: data.body,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setState({
          phase: 'error',
          error: 'Could not prepare a draft. There may not be enough recorded context yet.',
        });
      }
    })();
    return () => controller.abort();
  }, [payload]);

  const queue = async () => {
    if (state.phase !== 'ready') return;
    setPending(true);
    const result = await invokeToolAction('draft_email', {
      to: state.to.split(/\s*,\s*/).filter(Boolean),
      subject: state.subject,
      body: state.body,
      accountId: payload['accountId'],
      contactId: payload['contactId'],
      opportunityId: payload['opportunityId'],
    });
    setPending(false);

    toast(
      result.ok
        ? {
            title: result.data?.needsApproval ? 'Draft queued for approval' : 'Draft saved',
            description: 'Nothing has been sent. Review it in the Inbox before it goes out.',
            tone: 'success',
          }
        : { title: 'Could not save the draft', description: result.error, tone: 'error' },
    );
    if (result.ok) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Draft follow-up"
      description="Composed from recorded commitments and next steps. Saved as a draft — sending needs a separate approval."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Discard
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={queue}
            disabled={pending || state.phase !== 'ready'}
          >
            {pending && <Spinner className="size-3" />}
            Save draft
          </Button>
        </>
      }
    >
      {state.phase === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
          <Spinner className="size-4" />
          Reading the conversation history…
        </div>
      )}

      {state.phase === 'error' && (
        <p className="rounded-[var(--radius-md)] border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger-text">
          {state.error}
        </p>
      )}

      {state.phase === 'ready' && (
        <div className="space-y-4">
          <Field label="To">
            <Input value={state.to} onChange={(e) => setState({ ...state, to: e.target.value })} />
          </Field>
          <Field label="Subject">
            <Input
              value={state.subject}
              onChange={(e) => setState({ ...state, subject: e.target.value })}
            />
          </Field>
          <Field
            label="Body"
            hint="Every line here traces to a recorded commitment, question or next step."
          >
            <Textarea
              rows={16}
              value={state.body}
              onChange={(e) => setState({ ...state, body: e.target.value })}
              className="font-mono text-xs leading-relaxed"
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
