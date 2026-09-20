'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { AutomationAction, ConditionNode } from '@/db/schema';
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
import { saveAutomationAction } from '../actions';
import { AlertTriangle, Close, Plus } from '@/components/layout/icons';
import { cn } from '@/lib/utils';

/**
 * Automation builder.
 *
 * Trigger, conditions, actions — in that order, because that is the order the
 * engine evaluates them and the order a person reasons about them. The
 * available condition fields depend on the trigger, so you cannot build a
 * condition against a fact the trigger will never supply.
 */

const TRIGGERS = [
  { value: 'opportunity.inactive', label: 'A deal goes quiet', scope: 'opportunity' },
  { value: 'opportunity.stage_changed', label: 'A deal changes stage', scope: 'opportunity' },
  { value: 'meeting.completed', label: 'A meeting completes', scope: 'meeting' },
  { value: 'email.received', label: 'An email arrives', scope: 'email' },
  { value: 'contact.created', label: 'A contact is created', scope: 'contact' },
  { value: 'account.sentiment_dropped', label: 'Account sentiment drops', scope: 'account' },
  { value: 'commitment.due_soon', label: 'A commitment is due soon', scope: 'commitment' },
  { value: 'task.completed', label: 'A task is completed', scope: 'task' },
] as const;

/** Fields available per trigger scope — the facts the engine will actually have. */
const FIELDS: Record<string, { value: string; label: string; type: 'number' | 'string' }[]> = {
  opportunity: [
    { value: 'opportunity.value', label: 'Deal value', type: 'number' },
    { value: 'opportunity.daysSinceActivity', label: 'Days since activity', type: 'number' },
    { value: 'opportunity.healthScore', label: 'Health score', type: 'number' },
    { value: 'opportunity.status', label: 'Status', type: 'string' },
    { value: 'opportunity.stageName', label: 'Stage', type: 'string' },
    { value: 'account.industry', label: 'Account industry', type: 'string' },
  ],
  account: [
    { value: 'account.sentiment', label: 'Sentiment', type: 'number' },
    { value: 'account.healthScore', label: 'Health score', type: 'number' },
    { value: 'account.lifecycleStage', label: 'Lifecycle stage', type: 'string' },
    { value: 'account.employeeCount', label: 'Employee count', type: 'number' },
  ],
  meeting: [
    { value: 'meeting.sentimentLabel', label: 'Sentiment', type: 'string' },
    { value: 'meeting.objectionCount', label: 'Objections raised', type: 'number' },
    { value: 'meeting.participantCount', label: 'Participants', type: 'number' },
  ],
  email: [
    { value: 'email.direction', label: 'Direction', type: 'string' },
    { value: 'email.subject', label: 'Subject', type: 'string' },
    { value: 'email.sentiment', label: 'Sentiment', type: 'number' },
  ],
  contact: [
    { value: 'contact.seniority', label: 'Seniority', type: 'string' },
    { value: 'contact.buyingRole', label: 'Buying role', type: 'string' },
  ],
  commitment: [
    { value: 'commitment.direction', label: 'Direction', type: 'string' },
    { value: 'commitment.daysUntilDue', label: 'Days until due', type: 'number' },
  ],
  task: [{ value: 'task.priority', label: 'Priority', type: 'string' }],
};

const ACTIONS: { kind: AutomationAction['kind']; label: string; risk: AutomationAction['riskLevel']; detail: string }[] = [
  { kind: 'ask_ai', label: 'Ask AI', risk: 'low', detail: 'Answer a question about the record and record the answer.' },
  { kind: 'create_task', label: 'Create task', risk: 'medium', detail: 'Create a task for the record owner.' },
  { kind: 'add_note', label: 'Add note', risk: 'medium', detail: 'Attach an internal note.' },
  { kind: 'draft_email', label: 'Draft email', risk: 'medium', detail: 'Save a draft for review. Never sends.' },
  { kind: 'run_agent', label: 'Run agent', risk: 'low', detail: 'Hand off to an agent with its own tool set.' },
  { kind: 'send_slack', label: 'Slack notification', risk: 'medium', detail: 'Requires a connected Slack workspace.' },
  { kind: 'call_webhook', label: 'Call webhook', risk: 'high', detail: 'Requires a configured endpoint and signing secret.' },
];

const COMPARATORS = [
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is set' },
] as const;

type Clause = {
  field: string;
  comparator: (typeof COMPARATORS)[number]['value'];
  value: string;
};

export function AutomationBuilder({ agents }: { agents: { id: string; name: string }[] }) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [triggerEvent, setTriggerEvent] = React.useState<string>(TRIGGERS[0].value);
  const [combinator, setCombinator] = React.useState<'and' | 'or'>('and');
  const [clauses, setClauses] = React.useState<Clause[]>([]);
  const [selected, setSelected] = React.useState<AutomationAction[]>([]);
  const [saving, setSaving] = React.useState(false);

  const scope = TRIGGERS.find((t) => t.value === triggerEvent)?.scope ?? 'opportunity';
  const fields = FIELDS[scope] ?? [];

  // A trigger change invalidates any clause built against the old scope.
  React.useEffect(() => {
    setClauses((prev) => prev.filter((c) => fields.some((f) => f.value === c.field)));
  }, [triggerEvent, fields]);

  const addClause = () => {
    const first = fields[0];
    if (!first) return;
    setClauses((prev) => [...prev, { field: first.value, comparator: 'gt', value: '' }]);
  };

  const toggleAction = (spec: (typeof ACTIONS)[number]) => {
    setSelected((prev) => {
      const existing = prev.find((a) => a.kind === spec.kind);
      if (existing) return prev.filter((a) => a.kind !== spec.kind);
      return [
        ...prev,
        {
          id: `action_${prev.length + 1}`,
          kind: spec.kind,
          params: defaultParamsFor(spec.kind),
          riskLevel: spec.risk,
        },
      ];
    });
  };

  const updateActionParam = (kind: string, key: string, value: string) => {
    setSelected((prev) =>
      prev.map((a) => (a.kind === kind ? { ...a, params: { ...a.params, [key]: value } } : a)),
    );
  };

  const conditions: ConditionNode | null =
    clauses.length === 0
      ? null
      : clauses.length === 1
        ? toNode(clauses[0]!, fields)
        : { op: combinator, children: clauses.map((c) => toNode(c, fields)) };

  const save = async () => {
    setSaving(true);
    const result = await saveAutomationAction({
      name,
      description: description || undefined,
      trigger: { kind: 'event', event: triggerEvent },
      conditions,
      actions: selected,
      enabled: true,
    });
    setSaving(false);

    if (!result.ok) {
      toast({ title: 'Could not save', description: result.error, tone: 'error' });
      return;
    }
    toast({ title: result.message ?? 'Saved.', tone: 'success' });
    router.push('/automations');
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Name it</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4 pt-0">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Flag large deals going quiet"
                autoFocus
              />
            </Field>
            <Field label="What it does" hint="Optional. Shown on the automations list.">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When an open deal above $50k has no customer activity for 10 days, notify the owner."
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>1 · When this happens</CardTitle>
          </CardHeader>
          <CardBody className="pt-0">
            <Select
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              aria-label="Trigger"
            >
              {TRIGGERS.map((trigger) => (
                <option key={trigger.value} value={trigger.value}>
                  {trigger.label}
                </option>
              ))}
            </Select>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>2 · And these are true</CardTitle>
              <p className="mt-0.5 text-2xs text-text-subtle">
                Leave empty to run on every trigger. Only fields the trigger provides are offered.
              </p>
            </div>
            {clauses.length > 1 && (
              <div className="flex items-center gap-0.5 rounded-[var(--radius-sm)] bg-bg-muted p-0.5">
                {(['and', 'or'] as const).map((op) => (
                  <button
                    key={op}
                    type="button"
                    onClick={() => setCombinator(op)}
                    className={cn(
                      'rounded-[var(--radius-xs)] px-2 py-0.5 text-2xs font-medium uppercase transition-colors',
                      combinator === op ? 'bg-surface text-text shadow-[var(--shadow-sm)]' : 'text-text-subtle',
                    )}
                  >
                    {op}
                  </button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardBody className="pt-0">
            {clauses.length === 0 ? (
              <p className="text-xs text-text-subtle">No conditions — runs on every trigger.</p>
            ) : (
              <ul className="space-y-2">
                {clauses.map((clause, i) => {
                  const field = fields.find((f) => f.value === clause.field);
                  const needsValue =
                    clause.comparator !== 'is_empty' && clause.comparator !== 'is_not_empty';

                  return (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <Select
                        value={clause.field}
                        onChange={(e) =>
                          setClauses((prev) =>
                            prev.map((c, j) => (j === i ? { ...c, field: e.target.value } : c)),
                          )
                        }
                        className="h-8 w-auto min-w-40 text-xs"
                        aria-label="Field"
                      >
                        {fields.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </Select>

                      <Select
                        value={clause.comparator}
                        onChange={(e) =>
                          setClauses((prev) =>
                            prev.map((c, j) =>
                              j === i
                                ? { ...c, comparator: e.target.value as Clause['comparator'] }
                                : c,
                            ),
                          )
                        }
                        className="h-8 w-auto min-w-36 text-xs"
                        aria-label="Comparator"
                      >
                        {COMPARATORS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </Select>

                      {needsValue && (
                        <Input
                          value={clause.value}
                          onChange={(e) =>
                            setClauses((prev) =>
                              prev.map((c, j) => (j === i ? { ...c, value: e.target.value } : c)),
                            )
                          }
                          type={field?.type === 'number' ? 'number' : 'text'}
                          placeholder={field?.type === 'number' ? '50000' : 'value'}
                          className="h-8 w-32 text-xs"
                          aria-label="Value"
                        />
                      )}

                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => setClauses((prev) => prev.filter((_, j) => j !== i))}
                        aria-label="Remove condition"
                      >
                        <Close />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            <Button variant="ghost" size="sm" className="mt-2" onClick={addClause} disabled={fields.length === 0}>
              <Plus />
              Add condition
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3 · Then do this</CardTitle>
          </CardHeader>
          <CardBody className="pt-0">
            <ul className="space-y-1.5">
              {ACTIONS.map((spec) => {
                const chosen = selected.find((a) => a.kind === spec.kind);
                return (
                  <li key={spec.kind}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-md)] border px-2.5 py-2 transition-colors',
                        chosen ? 'border-accent-border bg-accent-subtle' : 'border-border hover:bg-surface-hover',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(chosen)}
                        onChange={() => toggleAction(spec)}
                        className="mt-0.5 size-3.5 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium text-text">{spec.label}</span>
                          <Badge
                            tone={
                              spec.risk === 'high' ? 'danger' : spec.risk === 'medium' ? 'warning' : 'neutral'
                            }
                          >
                            {spec.risk} risk
                          </Badge>
                        </span>
                        <span className="mt-0.5 block text-2xs text-text-subtle text-pretty">
                          {spec.detail}
                        </span>
                      </span>
                    </label>

                    {chosen && <ActionParams action={chosen} agents={agents} onChange={updateActionParam} />}
                  </li>
                );
              })}
            </ul>

            {selected.some((a) => a.riskLevel !== 'low') && (
              <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-warning/30 bg-warning-subtle px-2.5 py-2 text-2xs text-warning-text text-pretty">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                Actions above low risk are held for human approval unless a workspace admin has
                enabled them in Settings → AI. The automation will still run; the action will wait.
              </p>
            )}
          </CardBody>
        </Card>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="lg"
            onClick={save}
            disabled={saving || name.trim().length < 2 || selected.length === 0}
          >
            {saving && <Spinner className="size-4" />}
            Create automation
          </Button>
          <Button variant="ghost" size="lg" onClick={() => router.push('/automations')} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>

      {/* ── Live summary ──────────────────────────────────────────────── */}
      <Card className="h-fit lg:sticky lg:top-6">
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          <dl className="space-y-3 text-xs">
            <div>
              <dt className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">When</dt>
              <dd className="mt-0.5 text-text-muted">
                {TRIGGERS.find((t) => t.value === triggerEvent)?.label}
              </dd>
            </div>
            <div>
              <dt className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">If</dt>
              <dd className="mt-0.5 text-text-muted text-pretty">
                {clauses.length === 0
                  ? 'Always'
                  : clauses
                      .map((c) => {
                        const field = fields.find((f) => f.value === c.field);
                        const comparator = COMPARATORS.find((x) => x.value === c.comparator);
                        return `${field?.label ?? c.field} ${comparator?.label ?? c.comparator} ${c.value}`.trim();
                      })
                      .join(` ${combinator.toUpperCase()} `)}
              </dd>
            </div>
            <div>
              <dt className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">Then</dt>
              <dd className="mt-0.5">
                {selected.length === 0 ? (
                  <span className="text-text-subtle">Nothing selected yet</span>
                ) : (
                  <span className="flex flex-wrap gap-1.5">
                    {selected.map((a) => (
                      <Badge key={a.id} tone="neutral">
                        {ACTIONS.find((x) => x.kind === a.kind)?.label ?? a.kind}
                      </Badge>
                    ))}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function ActionParams({
  action,
  agents,
  onChange,
}: {
  action: AutomationAction;
  agents: { id: string; name: string }[];
  onChange: (kind: string, key: string, value: string) => void;
}) {
  if (action.kind === 'ask_ai') {
    return (
      <div className="mt-1.5 ml-6">
        <Input
          value={String(action.params['question'] ?? '')}
          onChange={(e) => onChange(action.kind, 'question', e.target.value)}
          placeholder="What happened with this deal and what should the owner do next?"
          className="h-8 text-xs"
          aria-label="Question to ask"
        />
      </div>
    );
  }

  if (action.kind === 'create_task') {
    return (
      <div className="mt-1.5 ml-6">
        <Input
          value={String(action.params['title'] ?? '')}
          onChange={(e) => onChange(action.kind, 'title', e.target.value)}
          placeholder="Re-engage {{opportunity.name}}"
          className="h-8 text-xs"
          aria-label="Task title"
        />
        <p className="mt-1 text-[10px] text-text-subtle">
          Use <code className="font-mono">{'{{field.path}}'}</code> to insert values from the trigger.
        </p>
      </div>
    );
  }

  if (action.kind === 'add_note') {
    return (
      <div className="mt-1.5 ml-6">
        <Textarea
          rows={2}
          value={String(action.params['body'] ?? '')}
          onChange={(e) => onChange(action.kind, 'body', e.target.value)}
          placeholder="Sentiment turned negative — review recent conversations."
          className="text-xs"
          aria-label="Note body"
        />
      </div>
    );
  }

  if (action.kind === 'run_agent') {
    return (
      <div className="mt-1.5 ml-6">
        <Select
          value={String(action.params['agentName'] ?? '')}
          onChange={(e) => onChange(action.kind, 'agentName', e.target.value)}
          className="h-8 text-xs"
          aria-label="Agent to run"
        >
          <option value="">Select an agent…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.name}>
              {agent.name}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  return null;
}

function toNode(clause: Clause, fields: { value: string; type: 'number' | 'string' }[]): ConditionNode {
  const field = fields.find((f) => f.value === clause.field);
  const numeric = field?.type === 'number';

  return {
    op: 'cmp',
    field: clause.field,
    comparator: clause.comparator,
    value:
      clause.comparator === 'is_empty' || clause.comparator === 'is_not_empty'
        ? undefined
        : numeric
          ? Number(clause.value)
          : clause.value,
  };
}

function defaultParamsFor(kind: AutomationAction['kind']): Record<string, unknown> {
  switch (kind) {
    case 'ask_ai':
      return { question: 'What happened with this record and what should the owner do next?' };
    case 'create_task':
      return { title: 'Follow up', priority: 'high', dueInDays: 1 };
    case 'add_note':
      return { body: '' };
    case 'run_agent':
      return { agentName: '' };
    default:
      return {};
  }
}
