'use client';

import * as React from 'react';
import Link from 'next/link';
import type { ApprovalPreview, NotificationKind, RiskLevel, SourceRef } from '@/db/schema';
import { Badge, Button, Card, CardBody, EmptyState, SectionLabel } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { ActionButtons } from '@/components/ai/action-buttons';
import { CitationChip } from '@/components/ai/citation';
import { ApprovalCard } from '@/components/ai/approval-card';
import { resolveNotificationAction, snoozeNotificationAction, refreshInboxAction } from '@/app/actions';
import { AlertTriangle, CheckCircle, Clock, NavIcon, Refresh } from '@/components/layout/icons';
import { cn, relativeTime } from '@/lib/utils';

type InboxItem = {
  id: string;
  kind: NotificationKind;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  recommendedAction: { label: string; kind: string; payload?: Record<string, unknown> } | null;
  severity: 'info' | 'warning' | 'critical';
  accountId: string | null;
  accountName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  contactId: string | null;
  createdAt: string;
};

type Approval = {
  id: string;
  tool: string;
  riskLevel: RiskLevel;
  title: string;
  rationale: string | null;
  preview: ApprovalPreview | null;
  payload: Record<string, unknown>;
  sources: SourceRef[];
  createdAt: string;
  expiresAt: string | null;
};

export function InboxView({
  items,
  approvals,
  counts,
  sections,
  initialSection,
}: {
  items: InboxItem[];
  approvals: Approval[];
  counts: Record<string, number>;
  sections: { kind: NotificationKind; label: string; description: string }[];
  initialSection?: string;
}) {
  const [active, setActive] = React.useState<string>(initialSection ?? 'all');
  const [refreshing, setRefreshing] = React.useState(false);
  const { toast } = useToast();

  const visible = React.useMemo(() => {
    if (active === 'all') return items;
    if (active === 'agent_approval') return [];
    return items.filter((i) => i.kind === active);
  }, [items, active]);

  const showApprovals = active === 'all' || active === 'agent_approval';

  const refresh = async () => {
    setRefreshing(true);
    const result = await refreshInboxAction();
    setRefreshing(false);
    toast(
      result.ok
        ? { title: result.message ?? 'Inbox rebuilt.', tone: 'success' }
        : { title: 'Could not rebuild', description: result.error, tone: 'error' },
    );
  };

  const total = (counts['total'] ?? 0) + approvals.length;

  return (
    <div className="grid gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
      {/* ── Section rail ──────────────────────────────────────────────── */}
      <nav aria-label="Inbox sections" className="min-w-0">
        <ul className="space-y-0.5">
          <li>
            <SectionButton
              label="Everything"
              count={total}
              active={active === 'all'}
              onClick={() => setActive('all')}
            />
          </li>
          {sections.map((section) => {
            const count =
              section.kind === 'agent_approval' ? approvals.length : (counts[section.kind] ?? 0);
            return (
              <li key={section.kind}>
                <SectionButton
                  label={section.label}
                  count={count}
                  active={active === section.kind}
                  onClick={() => setActive(section.kind)}
                  tone={section.kind === 'agent_approval' ? 'warning' : 'default'}
                />
              </li>
            );
          })}
        </ul>

        <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Spinner className="size-3.5" /> : <Refresh />}
          Rebuild
        </Button>

        <p className="mt-2 px-1 text-[10px] leading-relaxed text-text-subtle text-pretty">
          Items are derived from current state, so resolving the underlying issue clears them on the
          next rebuild.
        </p>
      </nav>

      {/* ── Items ─────────────────────────────────────────────────────── */}
      <div className="min-w-0 space-y-3">
        {showApprovals && approvals.length > 0 && (
          <>
            <div className="flex items-center gap-2">
              <SectionLabel>Waiting on your approval</SectionLabel>
              <Badge tone="warning">{approvals.length}</Badge>
            </div>
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
            {visible.length > 0 && <div className="h-2" />}
          </>
        )}

        {visible.length === 0 && (!showApprovals || approvals.length === 0) ? (
          <EmptyState
            icon={<CheckCircle />}
            title={active === 'all' ? 'Inbox is clear' : 'Nothing in this section'}
            description={
              active === 'all'
                ? 'No stalled deals, overdue commitments, unanswered questions or pending approvals.'
                : 'Try another section, or rebuild the inbox to re-derive items from current state.'
            }
          />
        ) : (
          visible.map((item) => <ItemCard key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}

function SectionButton({
  label,
  count,
  active,
  onClick,
  tone = 'default',
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: 'default' | 'warning';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-xs transition-colors',
        active ? 'bg-surface font-medium text-text shadow-[var(--shadow-sm)]' : 'text-text-muted hover:bg-bg-muted',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && (
        <Badge tone={tone === 'warning' ? 'warning' : active ? 'accent' : 'neutral'}>{count}</Badge>
      )}
    </button>
  );
}

function ItemCard({ item }: { item: InboxItem }) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const { toast } = useToast();

  if (hidden) return null;

  const act = async (kind: 'resolve' | 'snooze') => {
    setPending(kind);
    const result =
      kind === 'resolve'
        ? await resolveNotificationAction(item.id)
        : await snoozeNotificationAction(item.id, 3);
    setPending(null);

    if (result.ok) {
      setHidden(true);
      toast({ title: result.message ?? 'Done.', tone: 'success' });
    } else {
      toast({ title: 'Could not update', description: result.error, tone: 'error' });
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span
          className={cn(
            'mt-0.5 shrink-0',
            item.severity === 'critical'
              ? 'text-danger'
              : item.severity === 'warning'
                ? 'text-warning'
                : 'text-text-subtle',
          )}
        >
          {item.kind === 'commitment' ? (
            <Clock className="size-4" />
          ) : item.severity === 'info' ? (
            <NavIcon name="inbox" className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="min-w-0 text-sm font-medium text-text text-pretty">{item.title}</p>
            <span className="shrink-0 text-2xs text-text-subtle">{relativeTime(item.createdAt)}</span>
          </div>

          {/* What happened / why it matters — both always rendered. */}
          <p className="mt-1.5 text-xs leading-relaxed text-text-muted text-pretty">
            {item.whatHappened}
          </p>
          <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-text-muted text-pretty">
            <span className="shrink-0 font-medium text-text-subtle">Why:</span>
            <span>{item.whyItMatters}</span>
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.accountId && item.accountName && (
              <CitationChip source={{ type: 'account', id: item.accountId, label: item.accountName }} />
            )}
            {item.opportunityId && item.opportunityName && (
              <CitationChip
                source={{ type: 'opportunity', id: item.opportunityId, label: item.opportunityName }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border bg-bg-subtle px-4 py-2.5">
        {item.recommendedAction && (
          <ActionButtons
            size="sm"
            actions={[
              {
                label: item.recommendedAction.label,
                kind: item.recommendedAction.kind,
                payload: item.recommendedAction.payload,
              },
            ]}
            context={{
              accountId: item.accountId,
              opportunityId: item.opportunityId,
              contactId: item.contactId,
            }}
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => act('snooze')} disabled={pending !== null}>
            {pending === 'snooze' && <Spinner className="size-3" />}
            Snooze 3d
          </Button>
          <Button variant="ghost" size="sm" onClick={() => act('resolve')} disabled={pending !== null}>
            {pending === 'resolve' && <Spinner className="size-3" />}
            Done
          </Button>
        </div>
      </div>
    </Card>
  );
}
