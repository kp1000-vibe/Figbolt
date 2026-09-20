import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { getAccountFacets, listAccounts } from '@/server/crm/accounts';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  EmptyState,
  HealthScore,
  PageHeader,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { AccountFiltersBar } from './filters';
import { NavIcon, TrendDown, TrendUp } from '@/components/layout/icons';
import { moneyShort, number, relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [{ rows, total }, facets] = await Promise.all([
    listAccounts(ctx, {
      query: params['q'],
      industry: params['industry'],
      lifecycleStage: params['stage'],
      ownerId: params['owner'],
      tier: params['tier'],
      flag: params['flag'],
      sort: (params['sort'] as 'name' | 'health' | 'arr' | 'activity' | 'pipeline') ?? 'pipeline',
      direction: params['dir'] === 'asc' ? 'asc' : 'desc',
      limit: 100,
    }),
    getAccountFacets(ctx),
  ]);

  const totalArr = rows.reduce((sum, r) => sum + (r.currentArr ?? 0), 0);
  const totalPipeline = rows.reduce((sum, r) => sum + r.openPipeline, 0);

  return (
    <PageShell wide>
      <PageHeader
        title="Accounts"
        description={`${number(total)} companies · ${moneyShort(totalArr)} committed ARR · ${moneyShort(totalPipeline)} open pipeline`}
      />

      <div className="mt-5">
        <AccountFiltersBar facets={facets} current={params} />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="building" />}
          title="No accounts match"
          description="Try clearing a filter, or search for a different company."
        />
      ) : (
        <Card className="mt-4 overflow-hidden">
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th>Company</Th>
                <Th>Stage</Th>
                <Th>Health</Th>
                <Th align="right">Open pipeline</Th>
                <Th align="right">ARR</Th>
                <Th>Engagement</Th>
                <Th>Owner</Th>
                <Th align="right">Last contact</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((account) => (
                <Tr key={account.id}>
                  <Td>
                    <Link href={`/accounts/${account.id}`} className="group block min-w-0">
                      <span className="block truncate text-sm font-medium text-text group-hover:text-accent-text">
                        {account.name}
                      </span>
                      <span className="block truncate text-2xs text-text-subtle">
                        {[account.industry, account.employeeCount ? `${number(account.employeeCount)} employees` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        account.lifecycleStage === 'customer'
                          ? 'success'
                          : account.lifecycleStage === 'churned'
                            ? 'danger'
                            : account.lifecycleStage === 'opportunity'
                              ? 'accent'
                              : 'neutral'
                      }
                    >
                      {titleCase(account.lifecycleStage)}
                    </Badge>
                  </Td>
                  <Td>
                    <HealthScore score={account.healthScore} />
                  </Td>
                  <Td align="right">
                    <span className="text-sm text-text">{moneyShort(account.openPipeline)}</span>
                    {account.openDeals > 0 && (
                      <span className="block text-2xs text-text-subtle">
                        {account.openDeals} open
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    <span className="text-sm text-text-muted">{moneyShort(account.currentArr)}</span>
                  </Td>
                  <Td>
                    <EngagementCell trend={account.engagementTrend} concerns={account.openConcerns} />
                  </Td>
                  <Td>
                    <span className="text-xs text-text-muted">{account.ownerName ?? '—'}</span>
                  </Td>
                  <Td align="right">
                    <span className="text-xs text-text-muted">
                      {relativeTime(account.lastInteractionAt)}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
    </PageShell>
  );
}

function EngagementCell({
  trend,
  concerns,
}: {
  trend: string | null;
  concerns: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {trend === 'rising' && (
        <span className="flex items-center gap-1 text-2xs text-success-text">
          <TrendUp className="size-3" />
          Rising
        </span>
      )}
      {trend === 'declining' && (
        <span className="flex items-center gap-1 text-2xs text-danger-text">
          <TrendDown className="size-3" />
          Falling
        </span>
      )}
      {trend === 'steady' && <span className="text-2xs text-text-subtle">Steady</span>}
      {!trend && <span className="text-2xs text-text-subtle">—</span>}
      {concerns > 0 && (
        <Badge tone="warning" title={`${concerns} open concerns`}>
          {concerns}
        </Badge>
      )}
    </span>
  );
}
