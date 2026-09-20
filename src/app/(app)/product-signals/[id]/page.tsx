import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, requireCtx } from '@/server/context';
import { getThemeDetail } from '@/server/intelligence/signals';
import { PageShell } from '@/components/layout/app-shell';
import { Badge, Card, CardBody, CardHeader, CardTitle, Stat } from '@/components/ui/primitives';
import { EvidenceQuote } from '@/components/ai/citation';
import { moneyShort, number, relativeTime, shortDate, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { theme } = await getThemeDetail(ctx, id);
    return { title: theme.name };
  } catch {
    return { title: 'Product signal' };
  }
}

export default async function ThemePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getThemeDetail>>;
  try {
    detail = await getThemeDetail(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { theme, mentions } = detail;
  const accounts = new Map(mentions.filter((m) => m.accountId).map((m) => [m.accountId!, m]));
  const arr = [...accounts.values()].reduce((sum, m) => sum + (m.accountArr ?? 0), 0);
  const enterprise = [...accounts.values()].filter((m) => m.accountTier === 'enterprise').length;
  const blocking = mentions.filter((m) => m.urgency === 'blocking').length;

  return (
    <PageShell>
      <div className="min-w-0">
        <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
          <Link href="/product-signals" className="hover:text-text">
            Product signals
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-text">{theme.name}</h1>
          <Badge tone="outline">{titleCase(theme.category)}</Badge>
          <Badge tone={theme.status === 'shipped' ? 'success' : theme.status === 'open' ? 'neutral' : 'info'}>
            {titleCase(theme.status)}
          </Badge>
        </div>
        {theme.description && (
          <p className="mt-1.5 max-w-2xl text-sm text-text-muted text-pretty">{theme.description}</p>
        )}
      </div>

      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-4">
          <Stat label="Accounts asking" value={number(accounts.size)} hint={`${enterprise} enterprise`} />
          <Stat label="Mentions" value={number(mentions.length)} />
          <Stat label="Existing ARR" value={moneyShort(arr)} />
          <Stat
            label="Blocking mentions"
            value={number(blocking)}
            tone={blocking > 0 ? 'danger' : 'neutral'}
          />
        </CardBody>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <div>
            <CardTitle>What customers actually said</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              Verbatim, newest first — this is the raw research
            </p>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <ul className="space-y-4">
            {mentions.map((mention) => (
              <li key={mention.id} className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {mention.accountId ? (
                      <Link
                        href={`/accounts/${mention.accountId}`}
                        className="text-xs font-medium text-text hover:text-accent-text"
                      >
                        {mention.accountName}
                      </Link>
                    ) : (
                      <span className="text-xs font-medium text-text">Unlinked account</span>
                    )}
                    {mention.accountTier === 'enterprise' && <Badge tone="accent">Enterprise</Badge>}
                    <Badge
                      tone={
                        mention.urgency === 'blocking'
                          ? 'danger'
                          : mention.urgency === 'high'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {mention.urgency === 'blocking' ? 'Blocking' : titleCase(mention.urgency)}
                    </Badge>
                  </div>
                  <span className="shrink-0 text-2xs text-text-subtle">
                    {shortDate(mention.occurredAt)} · {Math.round(mention.confidence * 100)}% confidence
                  </span>
                </div>

                {mention.detail && (
                  <p className="mt-1 text-xs text-text-muted text-pretty">{mention.detail}</p>
                )}

                <EvidenceQuote
                  className="mt-1.5"
                  quote={mention.sourceQuote}
                  source={
                    mention.sourceType && mention.sourceId
                      ? {
                          type: mention.sourceType as 'email' | 'transcript' | 'meeting',
                          id: mention.sourceId,
                          label: 'Where this was said',
                          occurredAt: mention.occurredAt.toISOString(),
                        }
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </PageShell>
  );
}
