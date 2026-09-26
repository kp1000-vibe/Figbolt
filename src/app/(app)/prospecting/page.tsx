import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { deriveIcp, findLookalikes } from '@/server/intelligence/prospecting';
import { getEnrichmentProvider } from '@/server/intelligence/enrichment';
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
  SectionLabel,
  Stat,
} from '@/components/ui/primitives';
import { CitationList } from '@/components/ai/citation';
import { ProspectCard } from './prospect-card';
import { NavIcon, Sparkle } from '@/components/layout/icons';
import { money, moneyShort, number } from '@/lib/utils';

export const metadata = { title: 'Prospecting' };

/**
 * Outbound prospecting.
 *
 * The ICP is derived from the deals that actually closed fastest, so the whole
 * page rests on evidence the workspace already owns rather than on a profile
 * someone typed in. When there is not enough closed history to derive one, it
 * says so instead of guessing.
 */
export default async function ProspectingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const icp = await deriveIcp(ctx, 10);
  const provider = getEnrichmentProvider();
  const prospects = icp ? await findLookalikes(ctx, icp, { limit: 12, query: params.q }) : [];

  return (
    <PageShell wide>
      <PageHeader
        title="Prospecting"
        description="Find companies that look like the customers who closed fastest — with the reasoning and the outreach angle attached."
        eyebrow={
          <Badge tone={provider.live ? 'success' : 'accent'}>
            {provider.live ? `${provider.name} connected` : 'Fixture enrichment'}
          </Badge>
        }
      />

      {!icp ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="signal" />}
          title="Not enough closed history to derive an ICP"
          description="Prospecting works backwards from the deals you have actually won. Once at least three opportunities are closed-won, Figbolt derives the profile and scores lookalikes against it."
        />
      ) : (
        <>
          {/* ── Derived ICP ─────────────────────────────────────────────── */}
          <Card className="mt-5">
            <CardHeader>
              <div>
                <CardTitle>Your ideal customer, derived from outcomes</CardTitle>
                <p className="mt-0.5 text-2xs text-text-subtle">
                  Built from your {icp.sampleSize} fastest closed-won deals — not from a form
                </p>
              </div>
              <Badge tone="accent">
                <Sparkle className="size-3" />
                {icp.sampleSize} deals
              </Badge>
            </CardHeader>
            <CardBody className="pt-0">
              <p className="text-sm leading-relaxed text-text text-pretty">{icp.narrative}</p>

              <div className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-4">
                <Stat label="Avg deal value" value={moneyShort(icp.averageDealValue)} />
                <Stat label="Avg cycle" value={`${icp.averageCycleDays}d`} />
                <Stat
                  label="Headcount band"
                  value={
                    icp.employeeRange
                      ? `${number(icp.employeeRange.min)}–${number(icp.employeeRange.max)}`
                      : '—'
                  }
                  hint={icp.employeeRange ? `median ${number(icp.employeeRange.median)}` : undefined}
                />
                <Stat label="Top industry" value={icp.industries[0]?.value ?? '—'} />
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <SectionLabel>Industries that closed</SectionLabel>
                  <ul className="mt-1.5 space-y-1.5">
                    {icp.industries.map((industry) => (
                      <li key={industry.value} className="min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-xs text-text-muted">
                            {industry.value}
                          </span>
                          <span className="shrink-0 text-2xs tabular text-text-subtle">
                            {industry.count}
                          </span>
                        </div>
                        <ProgressBar
                          className="mt-1"
                          value={industry.count}
                          max={icp.sampleSize}
                          label={`${industry.count} of ${icp.sampleSize}`}
                        />
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <SectionLabel>What they were buying for</SectionLabel>
                  {icp.commonThemes.length === 0 ? (
                    <p className="mt-1.5 text-xs text-text-subtle">
                      No product themes recorded on those accounts yet.
                    </p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {icp.commonThemes.map((theme) => (
                        <Badge key={theme} tone="info" size="md">
                          {theme}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <SectionLabel className="mt-4">Fastest closes</SectionLabel>
                  <ul className="mt-1.5 space-y-1">
                    {icp.basedOn.slice(0, 5).map((deal) => (
                      <li key={deal.accountId} className="flex items-baseline justify-between gap-2">
                        <Link
                          href={`/accounts/${deal.accountId}`}
                          className="min-w-0 truncate text-xs text-text-muted hover:text-accent-text"
                        >
                          {deal.name}
                        </Link>
                        <span className="shrink-0 text-2xs tabular text-text-subtle">
                          {money(deal.value)} · {deal.cycleDays}d
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {icp.evidence.length > 0 && (
                <div className="mt-4 border-t border-border pt-3">
                  <CitationList sources={icp.evidence} numbered={false} label="Evidence" />
                </div>
              )}
            </CardBody>
          </Card>

          {/* ── Candidates ──────────────────────────────────────────────── */}
          <div className="mt-6">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
              <SectionLabel>Lookalike accounts · {prospects.length}</SectionLabel>
              <span className="text-2xs text-text-subtle">
                Scored against the profile above. Accounts already in your CRM are excluded.
              </span>
            </div>

            {prospects.length === 0 ? (
              <EmptyState
                icon={<NavIcon name="building" />}
                title="No candidates returned"
                description={
                  provider.live
                    ? 'The enrichment provider returned nothing for this profile. Try widening the query.'
                    : 'The fixture provider had no match for that query. Clear it to see the full candidate pool.'
                }
              />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {prospects.map((prospect) => (
                  <ProspectCard key={prospect.name} prospect={prospect} />
                ))}
              </div>
            )}
          </div>

          {!provider.live && (
            <Card className="mt-6 border-accent-border bg-accent-subtle">
              <CardBody className="pt-4">
                <p className="text-xs font-semibold text-accent-text">
                  Running on fixture enrichment
                </p>
                <p className="mt-1.5 text-2xs leading-relaxed text-accent-text/85 text-pretty">
                  Candidates come from a built-in pool so the full flow — ICP derivation, scoring,
                  angle selection, drafting and review — runs with no data vendor. Set{' '}
                  <code className="font-mono">APOLLO_API_KEY</code> with{' '}
                  <code className="font-mono">INTEGRATION_MODE=live</code> to use real data; the
                  provider interface in <code className="font-mono">enrichment.ts</code> also fits
                  Clay, People Data Labs and Clearbit-style services. Figbolt does not scrape sites
                  whose terms prohibit it.
                </p>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </PageShell>
  );
}
