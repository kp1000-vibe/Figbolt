'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { Spinner, Tabs, useToast } from '@/components/ui/feedback';
import { CommitmentRow } from '@/components/crm/commitment-row';
import { setTaskStatusAction } from '@/app/actions';
import { CheckCircle, NavIcon } from '@/components/layout/icons';
import { cn, relativeTime, titleCase } from '@/lib/utils';

type Task = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  assigneeName: string | null;
  accountId: string | null;
  accountName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  createdByAgentId: string | null;
  sourceType: string | null;
};

type Commitment = React.ComponentProps<typeof CommitmentRow>['commitment'];

export function TasksView({
  tasks,
  weOwe,
  theyOwe,
  counts,
  initialTab,
  currentBucket,
}: {
  tasks: Task[];
  weOwe: Commitment[];
  theyOwe: Commitment[];
  counts: { open: number; overdue: number; today: number; completed: number; unassigned: number };
  initialTab?: string;
  currentBucket?: string;
}) {
  const [tab, setTab] = React.useState(initialTab === 'commitments' ? 'commitments' : 'tasks');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setBucket = (bucket: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (bucket) params.set('bucket', bucket);
    else params.delete('bucket');
    router.push(`${pathname}?${params.toString()}`);
  };

  const open = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const done = tasks.filter((t) => t.status === 'completed');

  return (
    <div>
      <Tabs
        tabs={[
          { id: 'tasks', label: 'Tasks', count: open.length },
          { id: 'commitments', label: 'Commitments', count: weOwe.length + theyOwe.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'tasks' && (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {[
              { value: null, label: 'All open', count: counts.open },
              { value: 'overdue', label: 'Overdue', count: counts.overdue },
              { value: 'today', label: 'Due today', count: counts.today },
              { value: 'week', label: 'This week' },
              { value: 'unassigned', label: 'Unassigned', count: counts.unassigned },
            ].map((option) => {
              const active = (currentBucket ?? null) === option.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBucket(option.value)}
                  className={cn(
                    'flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-2xs transition-colors',
                    active
                      ? 'border-accent-border bg-accent-subtle font-medium text-accent-text'
                      : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
                  )}
                >
                  {option.label}
                  {option.count != null && option.count > 0 && (
                    <span className="text-text-subtle">{option.count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {open.length === 0 && done.length === 0 ? (
            <EmptyState
              icon={<CheckCircle />}
              title="No tasks"
              description="Tasks appear here when you create one, when you convert a commitment, or when an agent proposes one."
            />
          ) : (
            <div className="space-y-4">
              {open.length > 0 && (
                <ul className="space-y-2">
                  {open.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </ul>
              )}

              {done.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer text-2xs font-semibold tracking-wide text-text-subtle uppercase">
                    Completed · {done.length}
                  </summary>
                  <ul className="mt-2 space-y-2 opacity-60">
                    {done.slice(0, 25).map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'commitments' && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>What we owe customers · {weOwe.length}</CardTitle>
                <p className="mt-0.5 text-2xs text-text-subtle">
                  Extracted from meetings and email, with the sentence each came from
                </p>
              </div>
            </CardHeader>
            <CardBody className="pt-0">
              {weOwe.length === 0 ? (
                <p className="text-xs text-text-subtle">Nothing outstanding on our side.</p>
              ) : (
                <ul className="space-y-4">
                  {weOwe.map((c) => (
                    <CommitmentRow key={c.id} commitment={c} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What customers owe us · {theyOwe.length}</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {theyOwe.length === 0 ? (
                <p className="text-xs text-text-subtle">Nothing outstanding on their side.</p>
              ) : (
                <ul className="space-y-4">
                  {theyOwe.map((c) => (
                    <CommitmentRow key={c.id} commitment={c} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const [pending, setPending] = React.useState(false);
  const [completed, setCompleted] = React.useState(task.status === 'completed');
  const { toast } = useToast();

  const overdue = Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now() && !completed);

  const toggle = async () => {
    setPending(true);
    const next = completed ? 'open' : 'completed';
    const result = await setTaskStatusAction(task.id, next);
    setPending(false);

    if (result.ok) {
      setCompleted(!completed);
      toast({ title: result.message ?? 'Updated.', tone: 'success' });
    } else {
      toast({ title: 'Could not update', description: result.error, tone: 'error' });
    }
  };

  return (
    <Card as="li">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          aria-pressed={completed}
          aria-label={completed ? 'Mark as not done' : 'Mark as done'}
          // A 24px hit area around the 16px box: the box is the visual, the
          // button is what a thumb has to land on.
          className="group/check -m-1 mt-[-2px] flex size-6 shrink-0 items-center justify-center rounded-md"
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-[4px] border transition-colors',
              completed
                ? 'border-success bg-success text-white'
                : 'border-border-strong group-hover/check:border-accent',
            )}
          >
            {pending ? (
              <Spinner className="size-2.5" />
            ) : completed ? (
              <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden>
                <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className={cn('min-w-0 text-sm text-text text-pretty', completed && 'line-through opacity-60')}>
              {task.title}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {task.createdByAgentId && (
                <Badge tone="accent" title="Created by an agent">
                  Agent
                </Badge>
              )}
              {task.sourceType === 'commitment' && (
                <Badge tone="info" title="Linked to an extracted commitment">
                  Commitment
                </Badge>
              )}
              {task.priority !== 'normal' && (
                <Badge tone={task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'neutral'}>
                  {titleCase(task.priority)}
                </Badge>
              )}
            </div>
          </div>

          {task.description && (
            <p className="mt-0.5 text-2xs leading-relaxed text-text-muted text-pretty">
              {task.description}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-text-subtle">
            {task.dueAt && (
              <span className={overdue ? 'font-medium text-danger-text' : ''}>
                {overdue ? 'overdue' : 'due'} {relativeTime(task.dueAt)}
              </span>
            )}
            {!task.dueAt && <span>no due date</span>}
            <span>{task.assigneeName ?? 'Unassigned'}</span>
            {task.accountId && task.accountName && (
              <Link href={`/accounts/${task.accountId}`} className="inline-flex min-h-6 items-center hover:text-accent-text">
                {task.accountName}
              </Link>
            )}
            {task.opportunityId && task.opportunityName && (
              <Link href={`/opportunities/${task.opportunityId}`} className="inline-flex min-h-6 items-center hover:text-accent-text">
                {task.opportunityName}
              </Link>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
