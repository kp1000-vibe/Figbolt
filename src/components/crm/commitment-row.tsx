'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, Button } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { EvidenceQuote } from '@/components/ai/citation';
import { setCommitmentStatusAction } from '@/app/actions';
import { createTaskAction } from '@/app/actions';
import { relativeTime, shortDate } from '@/lib/utils';
import type { SourceRef } from '@/db/schema';

/**
 * A single extracted commitment.
 *
 * Shows the promise, who owes it, when, and — crucially — the verbatim
 * sentence it was extracted from. A commitment the user cannot verify against
 * the transcript is a commitment they will not trust, and confidence below the
 * confirmation threshold is labelled rather than hidden.
 */

type Commitment = {
  id: string;
  description: string;
  direction: 'we_owe' | 'they_owe';
  ownerLabel: string;
  dueAt: Date | null;
  status: string;
  confidence: number;
  sourceType: string;
  sourceId: string;
  sourceQuote: string | null;
  taskId?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  accountName?: string | null;
};

export function CommitmentRow({ commitment }: { commitment: Commitment }) {
  const [pending, setPending] = React.useState<string | null>(null);
  const { toast } = useToast();

  const overdue = Boolean(
    commitment.dueAt && commitment.dueAt.getTime() < Date.now() && commitment.status !== 'fulfilled',
  );

  const fulfil = async () => {
    setPending('fulfil');
    const result = await setCommitmentStatusAction(commitment.id, 'fulfilled');
    setPending(null);
    toast(
      result.ok
        ? { title: result.message ?? 'Marked as fulfilled.', tone: 'success' }
        : { title: 'Could not update', description: result.error, tone: 'error' },
    );
  };

  const makeTask = async () => {
    setPending('task');
    const result = await createTaskAction({
      title: commitment.description,
      priority: overdue ? 'urgent' : 'high',
      dueInDays: 1,
      accountId: commitment.accountId ?? undefined,
      opportunityId: commitment.opportunityId ?? undefined,
      commitmentId: commitment.id,
    });
    setPending(null);
    toast(
      result.ok
        ? { title: result.message ?? 'Task created.', tone: 'success' }
        : { title: 'Could not create the task', description: result.error, tone: 'error' },
    );
  };

  const source: SourceRef | undefined =
    commitment.sourceType && commitment.sourceId
      ? {
          type: commitment.sourceType as SourceRef['type'],
          id: commitment.sourceId,
          label: 'Where this came from',
        }
      : undefined;

  return (
    <li className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text text-pretty">{commitment.description}</p>
          <p className="mt-0.5 text-2xs text-text-subtle">
            {commitment.ownerLabel}
            {commitment.accountName && ` · ${commitment.accountName}`}
            {commitment.dueAt && (
              <>
                {' · '}
                <span className={overdue ? 'font-medium text-danger-text' : ''}>
                  {overdue ? 'overdue' : 'due'} {relativeTime(commitment.dueAt)}
                </span>
              </>
            )}
            {!commitment.dueAt && ' · no date stated'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {commitment.status === 'unconfirmed' && (
            <Badge
              tone="neutral"
              title={`Extracted with ${Math.round(commitment.confidence * 100)}% confidence — worth confirming.`}
            >
              Unconfirmed
            </Badge>
          )}
          {commitment.status === 'fulfilled' && <Badge tone="success">Fulfilled</Badge>}
          {overdue && <Badge tone="danger">Overdue</Badge>}
        </div>
      </div>

      <EvidenceQuote className="mt-1.5" quote={commitment.sourceQuote} source={source} />

      {commitment.status !== 'fulfilled' && (
        <div className="mt-1.5 flex items-center gap-1">
          {commitment.taskId ? (
            <Link href="/tasks" className="-mx-1.5 inline-flex min-h-6 items-center px-1.5 text-2xs text-accent-text hover:underline">
              Task created
            </Link>
          ) : (
            <Button variant="ghost" size="xs" onClick={makeTask} disabled={pending !== null}>
              {pending === 'task' && <Spinner className="size-3" />}
              Create task
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={fulfil} disabled={pending !== null}>
            {pending === 'fulfil' && <Spinner className="size-3" />}
            Mark done
          </Button>
        </div>
      )}
    </li>
  );
}
