'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CompiledAgent } from '@/server/agents/manage';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  SectionLabel,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { compileAgentAction, saveAgentAction } from '../actions';
import { AlertTriangle, ArrowRight, Shield, Sparkle } from '@/components/layout/icons';
import { cn, titleCase } from '@/lib/utils';

/**
 * The natural-language agent builder.
 *
 * Two phases with a hard boundary between them: **describe** produces a
 * proposal, **review** is where the human confirms or corrects it. Nothing is
 * saved from the description alone — an agent that fires on a schedule with a
 * misread filter is a mistake that repeats every morning, so the review step
 * is mandatory rather than a courtesy.
 */

type Tool = {
  name: string;
  description: string;
  risk: string;
  readOnly: boolean;
  permission: string;
};

const EXAMPLES = [
  'Every weekday morning, identify opportunities above $25,000 that have not had customer activity for 10 days. Research what happened and draft an email for the account owner.',
  'Whenever a meeting is completed, summarise it, pull out what we committed to, and draft a follow-up for the deal owner to review.',
  'Every Monday, review open deals and flag any whose pipeline stage looks wrong based on recent conversations. Propose the correct stage with evidence.',
  'Each morning, check every promise we made to a customer and flag anything due in the next two days or already overdue.',
];

export function AgentBuilder({
  tools,
  team,
  defaultRunAsUserId,
  existing,
}: {
  tools: Tool[];
  team: { id: string; name: string; role: string }[];
  defaultRunAsUserId: string;
  existing?: {
    id: string;
    prompt: string;
    compiled: CompiledAgent;
    enabled: boolean;
    runAsUserId: string | null;
  };
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [description, setDescription] = React.useState(existing?.prompt ?? '');
  const [compiled, setCompiled] = React.useState<CompiledAgent | null>(existing?.compiled ?? null);
  const [compiling, setCompiling] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [runAsUserId, setRunAsUserId] = React.useState(existing?.runAsUserId ?? defaultRunAsUserId);
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true);

  const compile = async () => {
    setCompiling(true);
    const result = await compileAgentAction(description);
    setCompiling(false);

    if (!result.ok) {
      toast({ title: 'Could not compile that', description: result.error, tone: 'error' });
      return;
    }
    if (result.data) {
      setCompiled(result.data);
      toast({
        title: 'Compiled — now review it',
        description: 'Check the trigger, filters and tool set before saving.',
        tone: 'success',
      });
    }
  };

  const save = async () => {
    if (!compiled) return;
    setSaving(true);

    const result = await saveAgentAction({
      id: existing?.id,
      name: compiled.name,
      description: compiled.description,
      prompt: description,
      instructions: compiled.instructions,
      trigger: compiled.trigger,
      toolNames: compiled.toolNames,
      steps: compiled.steps,
      filters: compiled.filters,
      autoApprove: compiled.approvalPolicy.autoApprove,
      enabled,
      runAsUserId,
    });
    setSaving(false);

    if (!result.ok) {
      toast({ title: 'Could not save', description: result.error, tone: 'error' });
      return;
    }
    toast({ title: result.message ?? 'Saved.', tone: 'success' });
    if (result.data) router.push(`/agents/${result.data.id}`);
  };

  const update = <K extends keyof CompiledAgent>(key: K, value: CompiledAgent[K]) => {
    setCompiled((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* ── Describe ──────────────────────────────────────────────────── */}
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>1 · Describe the task</CardTitle>
              <p className="mt-0.5 text-2xs text-text-subtle">
                Say what to look for, how often, and what to do about it.
              </p>
            </div>
          </CardHeader>
          <CardBody className="pt-0">
            <Textarea
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Every weekday morning, find my three most at-risk deals and tell me what I should do."
              className="text-sm leading-relaxed"
            />

            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={compile}
                disabled={compiling || description.trim().length < 20}
              >
                {compiling ? <Spinner className="size-4" /> : <Sparkle />}
                {compiled ? 'Recompile' : 'Compile agent'}
              </Button>
              {description.trim().length > 0 && description.trim().length < 20 && (
                <span className="text-2xs text-text-subtle">A bit more detail, please.</span>
              )}
            </div>
          </CardBody>
        </Card>

        {!compiled && (
          <Card>
            <CardHeader>
              <CardTitle>Examples</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <ul className="space-y-2">
                {EXAMPLES.map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => setDescription(example)}
                      className="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2 text-left text-xs leading-relaxed text-text-muted transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent-text text-pretty"
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Available tools</CardTitle>
          </CardHeader>
          <CardBody className="pt-0">
            <p className="mb-2.5 text-2xs leading-relaxed text-text-subtle text-pretty">
              Every tool re-checks the caller&rsquo;s permissions when it runs. Enabling one widens what
              the agent can attempt, never what it is allowed to do.
            </p>
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {tools.map((tool) => (
                <li key={tool.name} className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-1 size-1.5 shrink-0 rounded-full',
                      tool.readOnly
                        ? 'bg-success'
                        : tool.risk === 'high'
                          ? 'bg-danger'
                          : 'bg-warning',
                    )}
                  />
                  <div className="min-w-0">
                    <p className="font-mono text-2xs text-text">{tool.name}</p>
                    <p className="text-[10px] leading-snug text-text-subtle text-pretty">
                      {tool.description}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      {/* ── Review ────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        {!compiled ? (
          <Card className="border-dashed">
            <CardBody className="flex flex-col items-center justify-center py-16 text-center">
              <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-bg-muted text-text-subtle">
                <ArrowRight className="size-5" />
              </span>
              <p className="text-sm font-medium text-text">The compiled agent appears here</p>
              <p className="mt-1 max-w-xs text-xs text-text-muted text-pretty">
                You will be able to edit the trigger, filters, tools, plan and approval policy before
                anything is saved.
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>2 · Review &amp; edit</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    Compiled with {Math.round(compiled.confidence * 100)}% confidence — check it.
                  </p>
                </div>
              </CardHeader>
              <CardBody className="space-y-4 pt-0">
                <Field label="Name">
                  <Input value={compiled.name} onChange={(e) => update('name', e.target.value)} />
                </Field>

                <Field label="What it does">
                  <Input
                    value={compiled.description}
                    onChange={(e) => update('description', e.target.value)}
                  />
                </Field>

                <div>
                  <SectionLabel>Trigger</SectionLabel>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    <Select
                      value={compiled.trigger.kind}
                      onChange={(e) => {
                        const kind = e.target.value;
                        update(
                          'trigger',
                          kind === 'schedule'
                            ? { kind: 'schedule', cron: '0 8 * * 1-5', timezone: 'UTC' }
                            : kind === 'event'
                              ? { kind: 'event', event: 'meeting.completed' }
                              : { kind: 'manual' },
                        );
                      }}
                      aria-label="Trigger kind"
                    >
                      <option value="manual">Manual — run on demand</option>
                      <option value="schedule">Schedule</option>
                      <option value="event">On an event</option>
                    </Select>

                    {compiled.trigger.kind === 'schedule' && (
                      <Input
                        value={compiled.trigger.cron}
                        onChange={(e) =>
                          update('trigger', {
                            kind: 'schedule',
                            cron: e.target.value,
                            timezone:
                              compiled.trigger.kind === 'schedule' ? compiled.trigger.timezone : 'UTC',
                          })
                        }
                        placeholder="0 8 * * 1-5"
                        className="font-mono text-xs"
                        aria-label="Cron expression"
                      />
                    )}

                    {compiled.trigger.kind === 'event' && (
                      <Select
                        value={compiled.trigger.event}
                        onChange={(e) => update('trigger', { kind: 'event', event: e.target.value })}
                        aria-label="Event"
                      >
                        <option value="meeting.completed">Meeting completed</option>
                        <option value="email.received">Email received</option>
                        <option value="opportunity.stage_changed">Deal stage changed</option>
                        <option value="opportunity.inactive">Deal went quiet</option>
                        <option value="commitment.due_soon">Commitment due soon</option>
                      </Select>
                    )}
                  </div>
                  {compiled.trigger.kind === 'schedule' && (
                    <p className="mt-1 text-2xs text-text-subtle">
                      Five fields: minute hour day-of-month month day-of-week. Times are UTC.
                    </p>
                  )}
                </div>

                {Object.keys(compiled.filters).length > 0 && (
                  <div>
                    <SectionLabel>Filters</SectionLabel>
                    <div className="mt-1.5 space-y-2">
                      {Object.entries(compiled.filters).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                          <span className="w-28 shrink-0 font-mono text-2xs text-text-subtle">
                            {key}
                          </span>
                          <Input
                            value={String(value)}
                            onChange={(e) =>
                              update('filters', {
                                ...compiled.filters,
                                [key]: /^\d+$/.test(e.target.value)
                                  ? Number(e.target.value)
                                  : e.target.value,
                              })
                            }
                            className="h-8 text-xs"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <SectionLabel>Tools · {compiled.toolNames.length}</SectionLabel>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {tools.map((tool) => {
                      const on = compiled.toolNames.includes(tool.name);
                      return (
                        <button
                          key={tool.name}
                          type="button"
                          aria-pressed={on}
                          title={`${tool.description} (${tool.readOnly ? 'read-only' : `${tool.risk} risk`})`}
                          onClick={() =>
                            update(
                              'toolNames',
                              on
                                ? compiled.toolNames.filter((n) => n !== tool.name)
                                : [...compiled.toolNames, tool.name],
                            )
                          }
                          className={cn(
                            'rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors',
                            on
                              ? tool.readOnly
                                ? 'border-success/40 bg-success-subtle text-success-text'
                                : tool.risk === 'high'
                                  ? 'border-danger/40 bg-danger-subtle text-danger-text'
                                  : 'border-warning/40 bg-warning-subtle text-warning-text'
                              : 'border-border bg-surface text-text-subtle hover:border-border-strong',
                          )}
                        >
                          {tool.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <SectionLabel>Plan</SectionLabel>
                  <ol className="mt-1.5 space-y-2">
                    {compiled.steps.map((step, i) => (
                      <li
                        key={step.id}
                        className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-border bg-bg-subtle px-2.5 py-2"
                      >
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-surface text-[10px] font-bold text-text-muted">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-1.5">
                            <p className="text-xs font-medium text-text">{step.title}</p>
                            <Badge tone="outline">{step.kind}</Badge>
                            {step.tool && (
                              <span className="font-mono text-[10px] text-text-subtle">{step.tool}</span>
                            )}
                          </div>
                          {step.detail && (
                            <p className="mt-0.5 text-2xs leading-relaxed text-text-muted text-pretty">
                              {step.detail}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>

                <Field
                  label="Operating instructions"
                  hint="Handed to the agent as system context on every run."
                >
                  <Textarea
                    rows={7}
                    value={compiled.instructions}
                    onChange={(e) => update('instructions', e.target.value)}
                    className="font-mono text-xs leading-relaxed"
                  />
                </Field>
              </CardBody>
            </Card>

            {/* ── Permissions & safety ──────────────────────────────── */}
            <Card>
              <CardHeader>
                <div className="flex items-start gap-2">
                  <Shield className="mt-0.5 size-4 shrink-0 text-accent" />
                  <div>
                    <CardTitle>3 · Permissions &amp; safety</CardTitle>
                    <p className="mt-0.5 text-2xs text-text-subtle">
                      What this agent may do unattended
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardBody className="space-y-4 pt-0">
                <Field
                  label="Runs as"
                  hint="The agent inherits this person's permissions, clamped to their live role on every run."
                >
                  <Select value={runAsUserId} onChange={(e) => setRunAsUserId(e.target.value)}>
                    {team.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} ({member.role})
                      </option>
                    ))}
                  </Select>
                </Field>

                <div>
                  <SectionLabel>Run without approval</SectionLabel>
                  <div className="mt-1.5 space-y-1.5">
                    {(
                      [
                        { level: 'low' as const, label: 'Low risk', detail: 'Searching, reading, analysing.' },
                        {
                          level: 'medium' as const,
                          label: 'Medium risk',
                          detail: 'Creating tasks, editing fields, moving stages.',
                        },
                      ]
                    ).map((option) => {
                      const on = compiled.approvalPolicy.autoApprove.includes(option.level);
                      return (
                        <label
                          key={option.level}
                          className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] border border-border px-2.5 py-2 transition-colors hover:bg-surface-hover"
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              update('approvalPolicy', {
                                ...compiled.approvalPolicy,
                                autoApprove: on
                                  ? compiled.approvalPolicy.autoApprove.filter((l) => l !== option.level)
                                  : [...compiled.approvalPolicy.autoApprove, option.level],
                              })
                            }
                            className="mt-0.5 size-3.5 accent-[var(--accent)]"
                          />
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-text">{option.label}</span>
                            <span className="block text-2xs text-text-subtle">{option.detail}</span>
                          </span>
                        </label>
                      );
                    })}

                    <div className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-danger/25 bg-danger-subtle px-2.5 py-2">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger-text" />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-danger-text">
                          High risk always requires approval
                        </span>
                        <span className="block text-2xs text-danger-text/85 text-pretty">
                          Sending email, deleting records and bulk changes cannot be auto-approved from
                          here. A workspace admin can grant a specific agent autonomous sending in
                          Settings → AI.
                        </span>
                      </span>
                    </div>
                  </div>
                </div>

                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-text">Enable this agent immediately</span>
                </label>
              </CardBody>
            </Card>

            <div className="flex items-center gap-2">
              <Button variant="primary" size="lg" onClick={save} disabled={saving}>
                {saving && <Spinner className="size-4" />}
                {existing ? 'Save changes' : 'Create agent'}
              </Button>
              <Button variant="ghost" size="lg" onClick={() => router.push('/agents')} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
