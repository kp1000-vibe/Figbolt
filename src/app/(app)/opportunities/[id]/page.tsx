import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, requireCtx } from '@/server/context';
import { getOpportunityDetail } from '@/server/crm/opportunities';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  SectionLabel,
  Stat,
} from '@/components/ui/primitives';
import { AskInline } from '@/components/ai/ask-inline';
import { HealthPanel } from '@/components/ai/health-panel';
import { DealTabs } from './tabs';
import { DealHeaderActions } from './header-actions';
import { NextActions } from './next-actions';
import { AlertTriangle, NavIcon } from '@/components/layout/icons';
import { daysBetween, money, moneyShort, number, relativeTime, shortDate, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { opportunity } = await getOpportunityDetail(ctx, id);
    return { title: opportunity.name };
  } catch {
    return { title: 'Deal' };
  }
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getOpportunityDetail>>;
  try {
    detail = await getOpportunityDetail(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { opportunity: deal, account, stage, memory } = { ...detail, memory: detail.opportunity.memorySummary };
  const age = daysBetween(deal.createdAt);
  const daysInStage = daysBetween(deal.stageEnteredAt);
  const daysQuiet = deal.lastInteractionAt ? daysBetween(deal.lastInteractionAt) : null;
  const closeOverdue =
    deal.status === 'open' && deal.expectedCloseDate && deal.expectedCloseDate.getTime() < Date.now();

  return (
    <PageShell wide>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
            <Link href="/opportunities" className="hover:text-text">
              Deals
            </Link>
            <span>/</span>
            <Link href={`/accounts/${account.id}`} className="hover:text-text">
              {account.name}
            </Link>
          </nav>

          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-text text-balance">
              {deal.name}
            </h1>
            <Badge
              tone={deal.status === 'won' ? 'success' : deal.status === 'lost' ? 'danger' : 'accent'}
              size="md"
            >
              {stage.name}
            </Badge>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            <Link href={`/accounts/${account.id}`} className="hover:text-accent-text">
              {account.name}
            </Link>
            {account.industry && <span>{account.industry}</span>}
            <span>Owner: {detail.owner.name ?? 'Unassigned'}</span>
            <span>Age: {age}d</span>
          </div>
        </div>

        <DealHeaderActions
          opportunityId={deal.id}
          accountId={account.id}
          dealName={deal.name}
          stages={detail.stages}
          currentStageId={deal.stageId}
        />
      </div>

      {/* ── Vitals ────────────────────────────────────────────────────── */}
      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Value" value={money(deal.value)} hint={deal.currency} />
          <Stat
            label="Probability"
            value={deal.probability != null ? `${deal.probability}%` : '—'}
            hint="Stage default"
          />
          <Stat
            label="Expected close"
            value={deal.expectedCloseDate ? shortDate(deal.expectedCloseDate) : 'Not set'}
            hint={
              deal.expectedCloseDate
                ? closeOverdue
                  ? `${Math.abs(daysBetween(deal.expectedCloseDate))}d overdue`
                  : `in ${Math.abs(daysBetween(deal.expectedCloseDate))}d`
                : undefined
            }
            tone={closeOverdue ? 'danger' : 'neutral'}
          />
          <Stat label="Days in stage" value={`${daysInStage}d`} tone={daysInStage > 45 ? 'warning' : 'neutral'} />
          <Stat
            label="Last contact"
            value={relativeTime(deal.lastInteractionAt)}
            hint={`${detail.engagement.total} interactions (90d)`}
            tone={daysQuiet != null && daysQuiet > 14 ? 'danger' : 'neutral'}
          />
          <Stat
            label="Weighted"
            value={moneyShort((deal.value * (deal.probability ?? 0)) / 100)}
            hint="Value × probability"
          />
        </CardBody>
      </Card>

      {/* ── Ask about this deal ───────────────────────────────────────── */}
      <div className="mt-5">
        <AskInline
          placeholder={`Ask about ${deal.name}…`}
          scopeType="opportunity"
          scopeId={deal.id}
          scopeLabel={deal.name}
          suggestions={[
            'What is blocking this deal?',
            'What should I do next?',
            'Who else needs to be involved?',
          ]}
        />
      </div>

      {/* ── Deal intelligence ─────────────────────────────────────────── */}
      {memory ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Deal summary</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    Rebuilt from evidence{' '}
                    {deal.memoryUpdatedAt ? relativeTime(deal.memoryUpdatedAt) : 'recently'}
                  </p>
                </div>
              </CardHeader>
              <CardBody className="pt-0">
                <p className="text-sm leading-relaxed text-text text-pretty">{memory.summary}</p>

                <div className="mt-4">
                  <SectionLabel>Why they are buying</SectionLabel>
                  <p className="mt-1 text-sm leading-relaxed text-text-muted text-pretty">
                    {memory.whyBuying}
                  </p>
                </div>

                {memory.competitors.length > 0 && (
                  <div className="mt-4">
                    <SectionLabel>Competitors in play</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {memory.competitors.map((competitor) => (
                        <Badge key={competitor} tone="danger" size="md">
                          {competitor}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {memory.recentChanges.length > 0 && (
                  <div className="mt-4">
                    <SectionLabel>Recent changes</SectionLabel>
                    <ul className="mt-1.5 space-y-1.5">
                      {memory.recentChanges.slice(0, 5).map((change, i) => (
                        <li
                          key={i}
                          className="flex gap-2 text-xs leading-relaxed text-text-muted text-pretty"
                        >
                          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-text-subtle" />
                          <span>{change}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardBody>
            </Card>

            {memory.missingInformation.length > 0 && (
              <Card className="border-warning/30">
                <CardHeader>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div>
                      <CardTitle>Missing information</CardTitle>
                      <p className="mt-0.5 text-2xs text-text-subtle">
                        Qualification gaps, computed from what is actually on record
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardBody className="pt-0">
                  <ul className="space-y-1.5">
                    {memory.missingInformation.map((gap, i) => (
                      <li
                        key={i}
                        className="flex gap-2 text-xs leading-relaxed text-warning-text text-pretty"
                      >
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-warning" />
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            )}
          </div>

          <div className="min-w-0 space-y-5">
            <NextActions
              actions={memory.nextBestActions}
              accountId={account.id}
              opportunityId={deal.id}
            />

            <Card>
              <CardHeader>
                <CardTitle>Buying committee</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                {memory.keyStakeholders.length === 0 ? (
                  <p className="text-xs text-text-subtle">
                    No buying roles identified yet. Roles are inferred from conversations and are
                    editable on each contact.
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {memory.keyStakeholders.map((person) => (
                      <li key={person.contactId} className="min-w-0">
                        <Link
                          href={`/contacts/${person.contactId}`}
                          className="group flex items-baseline justify-between gap-2"
                        >
                          <span className="min-w-0 truncate text-xs font-medium text-text group-hover:text-accent-text">
                            {person.name}
                          </span>
                          <Badge
                            tone={
                              person.role === 'champion'
                                ? 'success'
                                : person.role === 'blocker'
                                  ? 'danger'
                                  : person.role === 'economic_buyer' || person.role === 'decision_maker'
                                    ? 'accent'
                                    : 'info'
                            }
                          >
                            {titleCase(person.role)}
                          </Badge>
                        </Link>
                        {person.note && (
                          <p className="mt-0.5 truncate text-2xs text-text-subtle">{person.note}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Stage criteria</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <p className="text-xs leading-relaxed text-text-muted text-pretty">
                  {stage.entryCriteria ?? 'No entry criteria defined for this stage.'}
                </p>
                <p className="mt-2 text-2xs text-text-subtle">
                  In {stage.name} for {daysInStage} days.
                </p>
              </CardBody>
            </Card>
          </div>
        </div>
      ) : (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="sparkles" />}
          title="No deal intelligence yet"
          description="Deal intelligence is built from recorded emails, meetings and notes on this opportunity."
        />
      )}

      {/* ── Health ────────────────────────────────────────────────────── */}
      <div className="mt-5">
        <HealthPanel score={deal.healthScore} rationale={deal.healthRationale} />
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div className="mt-6">
        <DealTabs detail={detail} />
      </div>
    </PageShell>
  );
}
