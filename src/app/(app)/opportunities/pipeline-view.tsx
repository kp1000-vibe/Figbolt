'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { getPipelineBoard, getPipelineFacets, listOpportunities } from '@/server/crm/opportunities';
import { moveOpportunityAction } from '@/app/actions';
import { FilterBar, type FilterSpec } from '@/components/crm/filter-bar';
import { Spinner, useToast } from '@/components/ui/feedback';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  HealthScore,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { Grid, List, NavIcon } from '@/components/layout/icons';
import { cn, daysBetween, money, moneyShort, relativeTime, shortDate } from '@/lib/utils';

type Board = Awaited<ReturnType<typeof getPipelineBoard>>;
type TableData = Awaited<ReturnType<typeof listOpportunities>>;
type Facets = Awaited<ReturnType<typeof getPipelineFacets>>;

export function PipelineView({
  view,
  board,
  table,
  facets,
  current,
}: {
  view: 'board' | 'table';
  board: Board | null;
  table: TableData | null;
  facets: Facets;
  current: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setView = (next: 'board' | 'table') => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', next);
    router.push(`${pathname}?${params.toString()}`);
  };

  const filters: FilterSpec[] = [
    { kind: 'search', key: 'q', placeholder: 'Search deal or account…' },
    {
      kind: 'select',
      key: 'owner',
      label: 'Owner',
      options: facets.owners.map((o) => ({ value: o.id, label: o.name })),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Status',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'won', label: 'Won' },
        { value: 'lost', label: 'Lost' },
      ],
    },
    {
      kind: 'chips',
      key: 'flag',
      label: 'Views',
      options: [
        { value: 'at_risk', label: 'At risk' },
        { value: 'quiet', label: 'No contact 14d+' },
        { value: 'closing_soon', label: 'Closing in 30d' },
        { value: 'overdue_close', label: 'Past forecast date' },
      ],
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <FilterBar
            filters={filters}
            current={current}
            sortOptions={
              view === 'table'
                ? [
                    { value: 'value', label: 'Value' },
                    { value: 'close', label: 'Close date' },
                    { value: 'health', label: 'Health' },
                    { value: 'activity', label: 'Last contact' },
                    { value: 'stage', label: 'Stage' },
                    { value: 'name', label: 'Name' },
                  ]
                : undefined
            }
          />
        </div>

        <div
          role="radiogroup"
          aria-label="View mode"
          className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-md)] bg-bg-muted p-0.5"
        >
          {(
            [
              { value: 'board' as const, Icon: Grid, label: 'Board' },
              { value: 'table' as const, Icon: List, label: 'Table' },
            ]
          ).map(({ value, Icon, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={view === value}
              onClick={() => setView(value)}
              className={cn(
                'flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs transition-colors',
                view === value
                  ? 'bg-surface font-medium text-text shadow-[var(--shadow-sm)]'
                  : 'text-text-subtle hover:text-text',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {view === 'board' && board && <KanbanBoard board={board} />}
        {view === 'table' && table && <DealTable data={table} />}
      </div>
    </div>
  );
}

/* ── Kanban ───────────────────────────────────────────────────────────────── */

/**
 * Drag-and-drop board using the native HTML5 drag API.
 *
 * Native drag avoids a dependency and gives keyboard users a working fallback
 * (each card carries a stage `<select>`). The move is optimistic — the card
 * jumps immediately and reverts if the server rejects it, because a board that
 * waits on a round-trip before moving feels broken.
 */
function KanbanBoard({ board }: { board: NonNullable<Board> }) {
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState<string | null>(null);
  const { toast } = useToast();

  // Apply optimistic stage overrides on top of the server's board.
  const columns = React.useMemo(() => {
    if (Object.keys(optimistic).length === 0) return board;

    const allDeals = board.flatMap((c) => c.deals);
    return board.map((column) => {
      const deals = allDeals.filter((deal) => {
        const stageId = optimistic[deal.id] ?? deal.stageId;
        return stageId === column.stage.id;
      });
      return {
        ...column,
        deals,
        count: deals.length,
        value: deals.reduce((sum, d) => sum + d.value, 0),
      };
    });
  }, [board, optimistic]);

  const move = async (dealId: string, stageId: string) => {
    const previous = board.flatMap((c) => c.deals).find((d) => d.id === dealId)?.stageId;
    if (!previous || previous === stageId) return;

    setOptimistic((prev) => ({ ...prev, [dealId]: stageId }));
    setPending(dealId);

    const result = await moveOpportunityAction({ opportunityId: dealId, stageId });
    setPending(null);

    if (!result.ok) {
      // Roll back so the board never shows a state the server rejected.
      setOptimistic((prev) => {
        const next = { ...prev };
        delete next[dealId];
        return next;
      });
      toast({ title: 'Could not move the deal', description: result.error, tone: 'error' });
    } else {
      toast({ title: result.message ?? 'Deal moved.', tone: 'success' });
    }
  };

  const stageOptions = board.map((c) => ({ id: c.stage.id, name: c.stage.name }));

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="flex min-w-max gap-3">
        {columns.map((column) => (
          <section
            key={column.stage.id}
            aria-label={`${column.stage.name}: ${column.count} deals`}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(column.stage.id);
            }}
            onDragLeave={() => setOverStage((s) => (s === column.stage.id ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              setOverStage(null);
              if (dragging) void move(dragging, column.stage.id);
              setDragging(null);
            }}
            className={cn(
              'flex w-72 shrink-0 flex-col rounded-[var(--radius-lg)] border bg-bg-subtle transition-colors',
              overStage === column.stage.id
                ? 'border-accent bg-accent-subtle/40'
                : 'border-border',
            )}
          >
            <header className="flex items-center gap-2 px-3 pt-3 pb-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: column.stage.color ?? 'var(--text-subtle)' }}
              />
              <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-text">
                {column.stage.name}
              </h3>
              <span className="shrink-0 text-2xs tabular text-text-subtle">
                {column.count} · {moneyShort(column.value)}
              </span>
            </header>

            {column.stage.entryCriteria && (
              <p
                className="mb-1 px-3 text-[10px] leading-snug text-text-subtle"
                title={column.stage.entryCriteria}
              >
                {column.stage.entryCriteria}
              </p>
            )}

            <div className="flex-1 space-y-2 p-2">
              {column.deals.length === 0 ? (
                <p className="rounded-[var(--radius-md)] border border-dashed border-border px-3 py-6 text-center text-2xs text-text-subtle">
                  Nothing here
                </p>
              ) : (
                column.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    stageOptions={stageOptions}
                    dragging={dragging === deal.id}
                    pending={pending === deal.id}
                    onDragStart={() => setDragging(deal.id)}
                    onDragEnd={() => setDragging(null)}
                    onStageChange={(stageId) => void move(deal.id, stageId)}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function DealCard({
  deal,
  stageOptions,
  dragging,
  pending,
  onDragStart,
  onDragEnd,
  onStageChange,
}: {
  deal: NonNullable<Board>[number]['deals'][number];
  stageOptions: { id: string; name: string }[];
  dragging: boolean;
  pending: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onStageChange: (stageId: string) => void;
}) {
  const daysQuiet = deal.lastInteractionAt ? daysBetween(deal.lastInteractionAt) : null;
  const daysInStage = daysBetween(deal.stageEnteredAt);

  return (
    <Card
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'group cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        pending && 'ring-2 ring-accent/30',
      )}
    >
      <div className="p-2.5">
        <div className="flex items-start justify-between gap-2">
          <Link
            href={`/opportunities/${deal.id}`}
            className="min-w-0 text-xs font-medium text-text hover:text-accent-text"
            draggable={false}
          >
            {deal.accountName}
          </Link>
          {pending && <Spinner className="size-3 shrink-0 text-accent" />}
        </div>

        <p className="mt-0.5 line-clamp-2 text-2xs text-text-subtle">{deal.name}</p>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold tabular text-text">{moneyShort(deal.value)}</span>
          <HealthScore score={deal.healthScore} showBar={false} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {daysQuiet != null && daysQuiet >= 14 && (
            <Badge tone="danger" title={`No customer interaction for ${daysQuiet} days`}>
              Quiet {daysQuiet}d
            </Badge>
          )}
          {deal.openConcerns > 0 && (
            <Badge tone="warning" title={`${deal.openConcerns} open concerns`}>
              {deal.openConcerns} concerns
            </Badge>
          )}
          {daysInStage > 45 && <Badge tone="neutral">{daysInStage}d in stage</Badge>}
          {deal.expectedCloseDate && deal.expectedCloseDate.getTime() < Date.now() && (
            <Badge tone="danger">Date passed</Badge>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="truncate text-2xs text-text-subtle">{deal.ownerName ?? 'Unassigned'}</span>
          <span className="shrink-0 text-2xs text-text-subtle">
            {deal.expectedCloseDate ? shortDate(deal.expectedCloseDate) : 'No date'}
          </span>
        </div>

        {/* Keyboard-accessible equivalent of dragging. */}
        <label className="mt-1.5 block">
          <span className="sr-only">Move {deal.name} to a different stage</span>
          <select
            value={deal.stageId}
            onChange={(e) => onStageChange(e.target.value)}
            className="w-full cursor-pointer rounded-[var(--radius-xs)] border border-transparent bg-transparent py-0.5 text-2xs text-text-subtle opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus:border-border focus:opacity-100"
          >
            {stageOptions.map((stage) => (
              <option key={stage.id} value={stage.id}>
                Move to {stage.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  );
}

/* ── Table ────────────────────────────────────────────────────────────────── */

function DealTable({ data }: { data: NonNullable<TableData> }) {
  if (data.rows.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="target" />}
        title="No deals match"
        description="Try clearing a filter or switching status."
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <Thead>
          <Tr className="hover:bg-transparent">
            <Th>Deal</Th>
            <Th>Stage</Th>
            <Th>Health</Th>
            <Th align="right">Value</Th>
            <Th align="right">Close</Th>
            <Th align="right">Days quiet</Th>
            <Th>Owner</Th>
          </Tr>
        </Thead>
        <Tbody>
          {data.rows.map((deal) => {
            const daysQuiet = deal.lastInteractionAt ? daysBetween(deal.lastInteractionAt) : null;
            return (
              <Tr key={deal.id}>
                <Td>
                  <Link href={`/opportunities/${deal.id}`} className="group block min-w-0">
                    <span className="block truncate text-sm font-medium text-text group-hover:text-accent-text">
                      {deal.accountName}
                    </span>
                    <span className="block truncate text-2xs text-text-subtle">{deal.name}</span>
                  </Link>
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: deal.stageColor ?? 'var(--text-subtle)' }}
                    />
                    <span className="text-xs text-text-muted">{deal.stageName}</span>
                  </span>
                </Td>
                <Td>
                  <HealthScore score={deal.healthScore} showBar={false} />
                </Td>
                <Td align="right">
                  <span className="text-sm text-text">{money(deal.value)}</span>
                </Td>
                <Td align="right">
                  <span
                    className={cn(
                      'text-xs',
                      deal.expectedCloseDate &&
                        deal.expectedCloseDate.getTime() < Date.now() &&
                        deal.status === 'open'
                        ? 'font-medium text-danger-text'
                        : 'text-text-muted',
                    )}
                  >
                    {shortDate(deal.expectedCloseDate)}
                  </span>
                </Td>
                <Td align="right">
                  <span
                    className={cn(
                      'text-xs',
                      daysQuiet != null && daysQuiet >= 14 ? 'font-medium text-danger-text' : 'text-text-muted',
                    )}
                  >
                    {daysQuiet != null ? `${daysQuiet}d` : '—'}
                  </span>
                </Td>
                <Td>
                  <span className="text-xs text-text-muted">{deal.ownerName ?? '—'}</span>
                </Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </Card>
  );
}
