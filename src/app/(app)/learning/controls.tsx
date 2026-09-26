'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Spinner, useToast } from '@/components/ui/feedback';
import { SectionLabel } from '@/components/ui/primitives';
import { Refresh, Play } from '@/components/layout/icons';
import { relativeTime } from '@/lib/utils';
import { decideProposalAction, runLoopAction } from './actions';

export function LoopControls({ hasCases }: { hasCases: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const run = async () => {
    setBusy(true);
    const result = await runLoopAction();
    setBusy(false);

    if (!result.ok) {
      toast({ tone: 'error', title: 'Could not run the loop', description: result.error });
      return;
    }
    toast({
      tone: 'success',
      title: result.message ?? 'Loop complete.',
      description: result.data?.proposals
        ? 'Proposals are listed below and need your approval.'
        : undefined,
    });
    router.refresh();
  };

  return (
    <Button size="sm" onClick={run} disabled={busy}>
      {busy ? <Spinner className="size-3.5" /> : hasCases ? <Refresh className="size-3.5" /> : <Play className="size-3.5" />}
      {busy ? 'Scoring…' : hasCases ? 'Re-run the loop' : 'Run the loop'}
    </Button>
  );
}

export type ProposalView = {
  id: string;
  task: string;
  title: string;
  rationale: string;
  target: string;
  change: Record<string, unknown>;
  failingCases: number;
  createdAt: Date;
};

export function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const [busy, setBusy] = React.useState<'approved' | 'rejected' | null>(null);
  const [decided, setDecided] = React.useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    const result = await decideProposalAction(proposal.id, decision);
    setBusy(null);

    if (!result.ok) {
      toast({ tone: 'error', title: 'Could not record that', description: result.error });
      return;
    }
    setDecided(decision);
    toast({ tone: 'success', title: `Proposal ${decision}`, description: result.message });
    router.refresh();
  };

  const direction = typeof proposal.change['direction'] === 'string' ? proposal.change['direction'] : null;
  const suggestion =
    typeof proposal.change['suggestion'] === 'string' ? proposal.change['suggestion'] : null;
  const examples = Array.isArray(proposal.change['examples'])
    ? (proposal.change['examples'] as unknown[]).map(String)
    : [];

  return (
    <li className="rounded-md border border-border bg-surface-sunken p-3.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone="neutral" size="sm">
          {proposal.task.replace(/^extract_/, '')}
        </Badge>
        {direction && (
          <Badge tone={direction === 'narrow' ? 'warning' : 'info'} size="sm">
            {direction}
          </Badge>
        )}
        <span className="min-w-0 text-xs font-semibold text-text">{proposal.title}</span>
      </div>

      <p className="mt-2 text-2xs leading-relaxed text-text-muted text-pretty">
        {proposal.rationale}
      </p>

      <div className="mt-2.5 space-y-1">
        <SectionLabel>Where a human would change it</SectionLabel>
        <code className="block break-all font-mono text-2xs text-accent-text">
          {proposal.target}
        </code>
      </div>

      {suggestion && (
        <div className="mt-2.5 space-y-1">
          <SectionLabel>Suggested change</SectionLabel>
          <p className="text-2xs leading-relaxed text-text-muted text-pretty">{suggestion}</p>
        </div>
      )}

      {examples.length > 0 && (
        <div className="mt-2.5 space-y-1">
          <SectionLabel>Cases that justify it</SectionLabel>
          <ul className="space-y-0.5">
            {examples.slice(0, 3).map((ex, i) => (
              <li key={i} className="truncate text-2xs text-text-subtle">
                “{ex}”
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        <span className="text-3xs text-text-subtle">
          {proposal.failingCases} failing case{proposal.failingCases === 1 ? '' : 's'} ·{' '}
          {relativeTime(proposal.createdAt)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {decided ? (
            <Badge tone={decided === 'approved' ? 'success' : 'neutral'} size="sm">
              {decided}
            </Badge>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => decide('rejected')}
              >
                {busy === 'rejected' && <Spinner className="size-3" />}
                Reject
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => decide('approved')}
              >
                {busy === 'approved' && <Spinner className="size-3" />}
                Approve
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
