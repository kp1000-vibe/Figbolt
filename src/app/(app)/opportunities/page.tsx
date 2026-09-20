import { requireCtx } from '@/server/context';
import {
  getPipelineBoard,
  getPipelineFacets,
  getPipelineSummary,
  listOpportunities,
} from '@/server/crm/opportunities';
import { PageShell } from '@/components/layout/app-shell';
import { Card, CardBody, PageHeader, Stat } from '@/components/ui/primitives';
import { PipelineView } from './pipeline-view';
import { moneyShort, number } from '@/lib/utils';

export const metadata = { title: 'Deals' };

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const filters = {
    query: params['q'],
    status: (params['status'] as 'open' | 'won' | 'lost') ?? undefined,
    ownerId: params['owner'],
    stageId: params['stage'],
    flag: params['flag'] as 'at_risk' | 'quiet' | 'closing_soon' | 'overdue_close' | undefined,
    minValue: params['min'] ? Number(params['min']) : undefined,
    sort: (params['sort'] as 'value' | 'close' | 'health' | 'activity' | 'name' | 'stage') ?? 'value',
    direction: params['dir'] === 'asc' ? ('asc' as const) : ('desc' as const),
  };

  const view = params['view'] === 'table' ? 'table' : 'board';

  // The board needs every open deal; the table paginates. Fetching only what
  // the active view needs keeps a 500-row board query off the table path.
  const [summary, facets, board, table] = await Promise.all([
    getPipelineSummary(ctx),
    getPipelineFacets(ctx),
    view === 'board'
      ? getPipelineBoard(ctx, { ...filters, status: filters.status ?? 'open' })
      : Promise.resolve(null),
    view === 'table' ? listOpportunities(ctx, { ...filters, limit: 200 }) : Promise.resolve(null),
  ]);

  return (
    <PageShell wide>
      <PageHeader
        title="Deals"
        description={`${number(summary.openCount)} open · ${moneyShort(summary.openValue)} pipeline · ${moneyShort(summary.weightedValue)} weighted`}
      />

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Open pipeline" value={moneyShort(summary.openValue)} hint={`${summary.openCount} deals`} />
          <Stat label="Weighted" value={moneyShort(summary.weightedValue)} hint="By stage probability" />
          <Stat
            label="At risk"
            value={moneyShort(summary.atRiskValue)}
            hint="Health at or below 45"
            tone={summary.atRiskValue > 0 ? 'danger' : 'neutral'}
          />
          <Stat label="Closing in 30d" value={moneyShort(summary.closingThirtyDays)} />
          <Stat
            label="Won this quarter"
            value={moneyShort(summary.wonValueThisQuarter)}
            hint={`${summary.wonThisQuarter} deals`}
            tone="success"
          />
        </CardBody>
      </Card>

      <div className="mt-5">
        <PipelineView
          view={view}
          board={board}
          table={table}
          facets={facets}
          current={params}
        />
      </div>
    </PageShell>
  );
}
