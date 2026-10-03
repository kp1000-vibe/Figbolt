import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { listThemes, signalCategoryCounts } from '@/server/intelligence/signals';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  ProgressBar,
  Stat,
} from '@/components/ui/primitives';
import { SignalFilters } from './filters';
import { NavIcon } from '@/components/layout/icons';
import { moneyShort, number, relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Product signals' };

const CATEGORY_LABEL: Record<string, string> = {
  feature_request: 'Feature request',
  bug: 'Bug',
  integration_request: 'Integration',
  security_requirement: 'Security',
  pricing_concern: 'Pricing',
  competitor: 'Competitor',
  workflow_pain: 'Workflow pain',
};

export default async function ProductSignalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [themes, categories] = await Promise.all([
    listThemes(ctx, params['category']),
    signalCategoryCounts(ctx),
  ]);

  const totalAccounts = themes.reduce((max, t) => Math.max(max, t.accountCount), 0);
  const totalPipeline = themes.reduce((sum, t) => sum + t.openPipeline, 0);
  const totalMentions = themes.reduce((sum, t) => sum + t.mentionCount, 0);
  const blocking = themes.filter((t) => t.blockingCount > 0).length;

  return (
    <PageShell>
      <PageHeader
        title="Product signals"
        description="What customers are asking for, extracted from real conversations and grouped by theme. Every mention keeps the sentence it came from."
      />

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-4">
          <Stat label="Themes" value={number(themes.length)} />
          <Stat label="Total mentions" value={number(totalMentions)} />
          <Stat
            label="Pipeline attached"
            value={moneyShort(totalPipeline)}
            hint="Open deals on requesting accounts"
          />
          <Stat
            label="Blocking a deal"
            value={number(blocking)}
            tone={blocking > 0 ? 'warning' : 'neutral'}
            hint="Themes with a blocking mention"
          />
        </CardBody>
      </Card>

      <div className="mt-5">
        <SignalFilters
          current={params}
          categories={categories.map((c) => ({
            value: c.category,
            label: CATEGORY_LABEL[c.category] ?? titleCase(c.category),
            count: c.n,
          }))}
        />
      </div>

      {themes.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="signal" />}
          title="No product signals yet"
          description="Signals are extracted from emails and meeting transcripts as customers ask for things. Once conversations are recorded, themes appear here."
        />
      ) : (
        <ul className="mt-4 space-y-2.5">
          {themes.map((theme) => (
            <Card as="li" key={`${theme.themeId ?? theme.name}`} className="overflow-hidden">
              <CardBody className="pt-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {theme.themeId ? (
                        <Link
                          href={`/product-signals/${theme.themeId}`}
                          className="inline-block py-0.5 text-sm font-medium text-text hover:text-accent-text"
                        >
                          {theme.name}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-text">{theme.name}</span>
                      )}
                      <Badge tone="outline">
                        {CATEGORY_LABEL[theme.category] ?? titleCase(theme.category)}
                      </Badge>
                      {theme.blockingCount > 0 && (
                        <Badge tone="danger">
                          Blocking {theme.blockingCount} {theme.blockingCount === 1 ? 'deal' : 'deals'}
                        </Badge>
                      )}
                      {theme.status !== 'open' && (
                        <Badge tone={theme.status === 'shipped' ? 'success' : 'info'}>
                          {titleCase(theme.status)}
                        </Badge>
                      )}
                    </div>

                    <p className="mt-1.5 text-xs text-text-muted">
                      <span className="font-medium text-text">{theme.accountCount}</span>{' '}
                      {theme.accountCount === 1 ? 'account' : 'accounts'} asked
                      {theme.enterpriseAccountCount > 0 && (
                        <> · {theme.enterpriseAccountCount} enterprise</>
                      )}
                      {' · '}
                      {theme.mentionCount} {theme.mentionCount === 1 ? 'mention' : 'mentions'}
                      {theme.lastMentionedAt && <> · last {relativeTime(theme.lastMentionedAt)}</>}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular text-text">
                      {moneyShort(theme.openPipeline)}
                    </p>
                    <p className="text-2xs text-text-subtle">open pipeline</p>
                    {theme.currentArr > 0 && (
                      <p className="mt-0.5 text-2xs text-text-subtle">
                        {moneyShort(theme.currentArr)} existing ARR
                      </p>
                    )}
                  </div>
                </div>

                {/* Relative demand, so the list reads as a ranking. */}
                <ProgressBar
                  className="mt-2.5"
                  value={theme.accountCount}
                  max={Math.max(totalAccounts, 1)}
                  tone={theme.blockingCount > 0 ? 'danger' : 'accent'}
                  label={`${theme.accountCount} of ${totalAccounts} accounts`}
                />
              </CardBody>
            </Card>
          ))}
        </ul>
      )}

      <Card className="mt-6 border-accent-border bg-accent-subtle">
        <CardBody className="pt-4">
          <p className="text-xs font-semibold text-accent-text">Why this is research, not a wishlist</p>
          <p className="mt-1.5 text-2xs leading-relaxed text-accent-text/85 text-pretty">
            Each theme is built from requests customers actually made, in their own words, with the
            deal value attached. That makes the trade-off explicit: shipping the top theme unblocks a
            known amount of pipeline, and declining it has a name and a number attached rather than
            being an abstraction.
          </p>
        </CardBody>
      </Card>
    </PageShell>
  );
}
