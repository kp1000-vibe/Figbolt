'use client';

import * as React from 'react';
import { Badge, Button, Field, Input } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { saveAiSettingsAction } from '../actions';
import { AlertTriangle } from '@/components/layout/icons';
import { cn } from '@/lib/utils';

type Settings = {
  autoApprove: { low: boolean; medium: boolean; high: boolean };
  maxStepsPerRun: number;
  redactPiiInPrompts: boolean;
  autonomousEmailAgentIds: string[];
};

export function AiSettingsForm({
  initial,
  agents,
}: {
  initial: Settings;
  agents: { id: string; name: string; enabled: boolean }[];
}) {
  const [settings, setSettings] = React.useState<Settings>(initial);
  const [pending, setPending] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const { toast } = useToast();

  const update = (next: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
    setDirty(true);
  };

  const submit = async () => {
    setPending(true);
    const result = await saveAiSettingsAction(settings);
    setPending(false);

    if (result.ok) {
      setDirty(false);
      toast({ title: result.message ?? 'Saved.', tone: 'success' });
    } else {
      toast({ title: 'Could not save', description: result.error, tone: 'error' });
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">
          Run without approval
        </p>
        <div className="mt-2 space-y-1.5">
          {(
            [
              {
                level: 'low' as const,
                label: 'Low risk',
                detail: 'Searching, reading, analysing. Recommended on — blocking these makes agents useless.',
              },
              {
                level: 'medium' as const,
                label: 'Medium risk',
                detail: 'Creating tasks and notes, editing whitelisted fields, moving stages.',
              },
              {
                level: 'high' as const,
                label: 'High risk',
                detail: 'Sending email, bulk changes, deletions. Strongly recommended off.',
              },
            ]
          ).map((option) => {
            const on = settings.autoApprove[option.level];
            return (
              <label
                key={option.level}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] border px-2.5 py-2 transition-colors',
                  on && option.level === 'high'
                    ? 'border-danger/40 bg-danger-subtle'
                    : on
                      ? 'border-accent-border bg-accent-subtle'
                      : 'border-border hover:bg-surface-hover',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    update({
                      autoApprove: { ...settings.autoApprove, [option.level]: e.target.checked },
                    })
                  }
                  className="mt-0.5 size-3.5 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-text">{option.label}</span>
                    {on && option.level === 'high' && <Badge tone="danger">Elevated</Badge>}
                  </span>
                  <span className="mt-0.5 block text-2xs text-text-subtle text-pretty">
                    {option.detail}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {settings.autoApprove.high && (
          <p className="mt-2 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger-subtle px-2.5 py-2 text-2xs text-danger-text text-pretty">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            With high risk enabled, an agent can email a customer without you seeing it first. The
            agent builder still refuses to set this per-agent; only this workspace-level switch can
            grant it, and it is recorded in the audit log.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Maximum steps per run"
          hint="Hard ceiling on tool calls in one run. Prevents a confused agent from looping."
        >
          <Input
            type="number"
            min={3}
            max={30}
            value={settings.maxStepsPerRun}
            onChange={(e) => update({ maxStepsPerRun: Number(e.target.value) })}
          />
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-medium text-text-muted">Privacy</p>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] border border-border px-2.5 py-2 transition-colors hover:bg-surface-hover">
            <input
              type="checkbox"
              checked={settings.redactPiiInPrompts}
              onChange={(e) => update({ redactPiiInPrompts: e.target.checked })}
              className="mt-0.5 size-3.5 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-text">
                Redact contact details in prompts
              </span>
              <span className="mt-0.5 block text-2xs text-text-subtle text-pretty">
                Replace email addresses and phone numbers with placeholders before a prompt leaves
                this machine. No effect when using the offline engine.
              </span>
            </span>
          </label>
        </div>
      </div>

      {agents.length > 0 && (
        <div>
          <p className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">
            Agents allowed to send email unattended
          </p>
          <p className="mt-1 text-2xs text-text-subtle text-pretty">
            A deliberate, per-agent exception to the high-risk rule. Everything sent this way is still
            mirrored into the CRM and written to the audit log.
          </p>
          <div className="mt-2 space-y-1.5">
            {agents.map((agent) => {
              const on = settings.autonomousEmailAgentIds.includes(agent.id);
              return (
                <label
                  key={agent.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] border px-2.5 py-1.5 transition-colors',
                    on ? 'border-warning/40 bg-warning-subtle' : 'border-border hover:bg-surface-hover',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      update({
                        autonomousEmailAgentIds: e.target.checked
                          ? [...settings.autonomousEmailAgentIds, agent.id]
                          : settings.autonomousEmailAgentIds.filter((id) => id !== agent.id),
                      })
                    }
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-text">{agent.name}</span>
                  {!agent.enabled && <Badge tone="neutral">paused</Badge>}
                  {on && <Badge tone="warning">can send</Badge>}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button variant="primary" size="md" onClick={submit} disabled={pending || !dirty}>
          {pending && <Spinner className="size-4" />}
          Save permissions
        </Button>
        {dirty && <span className="text-2xs text-text-subtle">Unsaved changes</span>}
      </div>
    </div>
  );
}
