import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCtx, NotFoundError } from '@/server/context';
import { getAccountDetail, getAccountTimeline, getRelationshipGraph } from '@/server/crm/accounts';
import { UsagePanel } from './usage-panel';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
  EmptyState,
  HealthScore,
  SectionLabel,
  Stat,
} from '@/components/ui/primitives';
import { AskInline } from '@/components/ai/ask-inline';
import { HealthPanel } from '@/components/ai/health-panel';
import { AccountTabs } from './tabs';
import { AccountHeaderActions } from './header-actions';
import { ArrowUpRight, NavIcon, TrendDown, TrendUp } from '@/components/layout/icons';
import { money, moneyShort, number, relativeTime, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { account } = await getAccountDetail(ctx, id);
    return { title: account.name };
  } catch {
    return { title: 'Account' };
  }
}

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getAccountDetail>>;
  try {
    detail = await getAccountDetail(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [timeline, graph] = await Promise.all([
    getAccountTimeline(ctx, id, { limit: 120 }),
    getRelationshipGraph(ctx, id),
  ]);

  const { account } = detail;
  const memory = account.memorySummary;
  const openPipeline = detail.opportunities
    .filter((o) => o.status === 'open')
    .reduce((sum, o) => sum + o.value, 0);

  return (
    <PageShell wide>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
            <Link href="/accounts" className="hover:text-text">
              Accounts
            </Link>
            <span>/</span>
            <span className="text-text-muted">{account.name}</span>
          </nav>

          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-text">{account.name}</h1>
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
              size="md"
            >
              {titleCase(account.lifecycleStage)}
            </Badge>
            {account.tier && <Badge tone="outline">{titleCase(account.tier)}</Badge>}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            {account.website && (
              <a
                href={account.website}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 hover:text-accent-text"
              >
                {account.domain}
                <ArrowUpRight className="size-3" />
              </a>
            )}
            {account.industry && <span>{account.industry}</span>}
            {account.employeeCount && <span>{number(account.employeeCount)} employees</span>}
            {account.location && <span>{account.location}</span>}
            {detail.ownerName && <span>Owner: {detail.ownerName}</span>}
          </div>
        </div>

        <AccountHeaderActions accountId={account.id} accountName={account.name} />
      </div>

      {/* ── Vitals ────────────────────────────────────────────────────── */}
      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <div className="min-w-0">
            <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">Health</p>
            <div className="mt-1.5">
              <HealthScore score={account.healthScore} />
            </div>
          </div>
          <Stat label="Open pipeline" value={moneyShort(openPipeline)} hint={`${detail.opportunities.filter((o) => o.status === 'open').length} deals`} />
          <Stat label="Committed ARR" value={moneyShort(account.currentArr)} />
          <Stat
            label="Interactions (90d)"
            value={number(detail.engagement.total)}
            hint={`${detail.engagement.perWeek}/week`}
          />
          <div className="min-w-0">
            <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">Trend</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
              {detail.engagement.trend === 'rising' && (
                <span className="flex items-center gap-1 text-success-text">
                  <TrendUp className="size-4" />
                  Rising
                </span>
              )}
              {detail.engagement.trend === 'declining' && (
                <span className="flex items-center gap-1 text-danger-text">
                  <TrendDown className="size-4" />
                  Falling
                </span>
              )}
              {detail.engagement.trend === 'steady' && <span className="text-text">Steady</span>}
            </p>
            <p className="mt-0.5 text-2xs text-text-muted">
              {detail.engagement.inbound} in · {detail.engagement.outbound} out
            </p>
          </div>
          <Stat
            label="Last contact"
            value={relativeTime(account.lastInteractionAt)}
            hint={detail.engagement.meetings > 0 ? `${detail.engagement.meetings} meetings` : undefined}
            tone={
              account.lastInteractionAt &&
              Date.now() - account.lastInteractionAt.getTime() > 30 * 86_400_000
                ? 'danger'
                : 'neutral'
            }
          />
        </CardBody>
      </Card>

      {/* ── Ask about this account ────────────────────────────────────── */}
      <div className="mt-5">
        <AskInline
          placeholder={`Ask about ${account.name}…`}
          scopeType="account"
          scopeId={account.id}
          scopeLabel={account.name}
          suggestions={[
            `What is blocking the ${account.name} deal?`,
            `What did we commit to ${account.name}?`,
            `What should I do next with ${account.name}?`,
          ]}
        />
      </div>

      {/* ── AI memory overview ────────────────────────────────────────── */}
      {memory ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Customer memory</CardTitle>
                <p className="mt-0.5 text-2xs text-text-subtle">
                  Rebuilt from evidence{' '}
                  {account.memoryUpdatedAt ? relativeTime(account.memoryUpdatedAt) : ''} · not
                  hand-maintained
                </p>
              </div>
            </CardHeader>
            <CardBody className="pt-0">
              <p className="text-sm leading-relaxed text-text text-pretty">{memory.relationship}</p>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <MemoryList label="Their goals" items={memory.customerGoals} />
                <MemoryList label="Current priorities" items={memory.currentPriorities} />
                <MemoryList label="Known risks" items={memory.knownRisks} tone="danger" />
                <MemoryList label="Recent changes" items={memory.recentChanges} />
                <MemoryList label="Upside" items={memory.opportunities} tone="success" />
                <MemoryList label="Open commitments" items={memory.openCommitments} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recommended actions</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {memory.recommendedActions.length === 0 ? (
                <p className="text-xs text-text-subtle">
                  Nothing pressing. No overdue commitments and the relationship is active.
                </p>
              ) : (
                <ul className="space-y-3">
                  {memory.recommendedActions.map((action, i) => (
                    <li key={i} className="min-w-0">
                      <p className="text-xs font-medium text-text text-pretty">{action.title}</p>
                      <p className="mt-0.5 text-2xs leading-relaxed text-text-muted text-pretty">
                        {action.why}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      ) : (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="sparkles" />}
          title="No customer memory yet"
          description="Memory is built from recorded emails, meetings and notes. Once there are interactions on this account it will appear here."
        />
      )}

      {/* ── Health rationale ──────────────────────────────────────────── */}
      <div className="mt-5">
        <HealthPanel
          title="Account health"
          score={account.healthScore}
          rationale={account.healthRationale}
        />
      </div>

      {/* ── Product usage + support ───────────────────────────────────── */}
      <UsagePanel ctx={ctx} accountId={id} />

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div className="mt-6">
        <AccountTabs detail={detail} timeline={timeline} graph={graph} />
      </div>
    </PageShell>
  );
}

function MemoryList({
  label,
  items,
  tone = 'neutral',
}: {
  label: string;
  items: string[];
  tone?: 'neutral' | 'danger' | 'success';
}) {
  if (items.length === 0) return null;

  return (
    <div className="min-w-0">
      <SectionLabel>{label}</SectionLabel>
      <ul className="mt-1.5 space-y-1.5">
        {items.slice(0, 5).map((item, i) => (
          <li key={i} className="flex gap-2 text-xs leading-relaxed text-text-muted text-pretty">
            <span
              className={
                tone === 'danger'
                  ? 'mt-1.5 size-1 shrink-0 rounded-full bg-danger'
                  : tone === 'success'
                    ? 'mt-1.5 size-1 shrink-0 rounded-full bg-success'
                    : 'mt-1.5 size-1 shrink-0 rounded-full bg-text-subtle'
              }
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
