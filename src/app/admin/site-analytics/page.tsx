import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { LogoTile } from '@/components/brand/logo';
import { getCurrentUser } from '@/lib/auth/session';
import { isSiteAdmin } from '@/lib/site-admin';
import { getSiteStats, type SiteStats } from '@/server/site-analytics';

export const metadata: Metadata = { title: 'Website analytics' };

const RANGES = [7, 30, 90] as const;

/**
 * Website analytics for figbolt.com — visible to the site's operator only.
 * Anyone else gets a 404, so the page's existence is not disclosed.
 */
export default async function SiteAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/admin/site-analytics');
  if (!isSiteAdmin(user.email)) notFound();

  const { days: raw } = await searchParams;
  const days = RANGES.find((r) => String(r) === raw) ?? 30;
  const stats = await getSiteStats(days);

  return (
    <main className="min-h-dvh bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-3.5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoTile className="size-7" />
            <span className="text-sm font-semibold tracking-tight text-text">Figbolt</span>
          </Link>
          <Link href="/home" className="inline-flex min-h-6 items-center text-sm text-text-muted hover:text-text">
            Back to the app
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Website visitors</h1>
            <p className="mt-1 text-sm text-text-muted">
              figbolt.com public pages · signed-in users and bots excluded
            </p>
          </div>
          <nav aria-label="Date range" className="flex gap-1 rounded-[var(--radius-md)] bg-bg-muted p-1">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={`/admin/site-analytics?days=${r}`}
                aria-current={r === days ? 'page' : undefined}
                className={
                  r === days
                    ? 'inline-flex min-h-7 items-center rounded-[var(--radius-sm)] bg-surface px-3 text-sm font-medium text-text shadow-[var(--shadow-sm)]'
                    : 'inline-flex min-h-7 items-center rounded-[var(--radius-sm)] px-3 text-sm text-text-subtle hover:text-text'
                }
              >
                {r} days
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Unique visitors today" value={stats.today.visitors} />
          <Stat label="Page views today" value={stats.today.views} />
          <Stat label={`Unique visitors, ${days} days`} value={stats.visitorDays} hint="summed per day" />
          <Stat label={`Page views, ${days} days`} value={stats.views} />
        </div>

        <DailyChart stats={stats} />

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Breakdown title="Top pages" rows={stats.topPages} empty="No visits yet" />
          <Breakdown title="Where visitors came from" rows={stats.topReferrers} empty="No referrals yet — direct visits and search apps often send none" />
          <Breakdown title="Countries" rows={stats.countries} empty="No country data yet" />
          <Breakdown title="Devices" rows={stats.devices} empty="No visits yet" />
        </div>

        <p className="mt-8 max-w-3xl text-xs leading-relaxed text-text-subtle text-pretty">
          How this is counted: no IP address or cookie is stored. Each visitor is a hash of their
          address and browser with a random salt that changes daily and is then deleted, so a
          person counts once per day and can never be traced afterwards. That makes the{' '}
          {days}-day figure a sum of daily uniques: someone who visits on three days counts three
          times. Visits are counted from the live site only, not from local development.
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      <p className="text-2xs font-medium uppercase tracking-[0.12em] text-text-subtle">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular text-text">{value.toLocaleString()}</p>
      {hint && <p className="mt-0.5 text-2xs text-text-subtle">{hint}</p>}
    </div>
  );
}

function DailyChart({ stats }: { stats: SiteStats }) {
  const max = Math.max(1, ...stats.daily.map((d) => d.visitors));
  const label = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <section className="mt-6 rounded-[var(--radius-lg)] border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Unique visitors per day</h2>
      <div className="mt-4 flex h-40 items-end gap-[2px]" role="img" aria-label={`Daily unique visitors over ${stats.days} days`}>
        {stats.daily.map((d) => (
          <div
            key={d.day}
            title={`${label(d.day)}: ${d.visitors} visitors, ${d.views} views`}
            className="min-w-0 flex-1 rounded-t-[2px] bg-accent/80 transition-colors hover:bg-accent"
            style={{ height: `${Math.max(d.visitors > 0 ? 3 : 1, (d.visitors / max) * 100)}%`, opacity: d.visitors > 0 ? 1 : 0.25 }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-2xs text-text-subtle tabular">
        <span>{label(stats.daily[0]!.day)}</span>
        <span>{label(stats.daily[stats.daily.length - 1]!.day)}</span>
      </div>
      {/* The same numbers as a table, for screen readers. */}
      <table className="sr-only">
        <caption>Daily unique visitors and page views</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Visitors</th>
            <th>Views</th>
          </tr>
        </thead>
        <tbody>
          {stats.daily.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.visitors}</td>
              <td>{d.views}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Breakdown({ title, rows, empty }: { title: string; rows: { label: string; count: number }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-text-subtle">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="relative flex items-center justify-between gap-3 px-2 py-1 text-sm">
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-[var(--radius-xs)] bg-accent-subtle"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
              <span className="relative min-w-0 truncate text-text">{r.label}</span>
              <span className="relative shrink-0 tabular text-text-muted">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
