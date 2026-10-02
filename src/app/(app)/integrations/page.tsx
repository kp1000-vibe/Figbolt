import { requireCtx } from '@/server/context';
import { listIntegrations, listSyncJobs } from '@/server/integrations/manage';
import { env } from '@/lib/env';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  SectionLabel,
  StatusDot,
} from '@/components/ui/primitives';
import { IntegrationCardActions } from './actions-client';
import { AlertTriangle, Shield } from '@/components/layout/icons';
import { number, relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Integrations' };

const KIND_LABEL: Record<string, string> = {
  mail: 'Email',
  calendar: 'Calendar',
  meetings: 'Meetings & recordings',
  notetaker: 'Notetakers & transcripts',
  scheduling: 'Scheduling links',
  calling: 'Phone & SMS',
  storage: 'Documents & storage',
  crm: 'CRM import',
  support: 'Support desk',
  product_analytics: 'Product analytics',
  billing: 'Billing',
  accounting: 'Accounting',
  messaging: 'Messaging',
  social: 'Professional network',
};

/**
 * The order categories appear in, most useful first for a small sales team.
 * Anything not listed falls to the end alphabetically.
 */
const KIND_ORDER = [
  'mail',
  'calendar',
  'notetaker',
  'meetings',
  'scheduling',
  'calling',
  'crm',
  'storage',
  'support',
  'product_analytics',
  'billing',
  'accounting',
  'messaging',
  'social',
];

/** What each build level means, said in the UI rather than implied. */
const LEVEL_NOTE: Record<string, { label: string; tone: 'success' | 'accent' | 'neutral'; hint: string }> = {
  adapter: {
    label: 'Syncs',
    tone: 'success',
    hint: 'Connect this and data really flows.',
  },
  oauth: {
    label: 'Connects',
    tone: 'accent',
    hint: 'The connection works; no sync adapter yet, so nothing is pulled.',
  },
  catalogue: {
    label: 'Planned',
    tone: 'neutral',
    hint: 'Declared with real scopes, but not yet connectable.',
  },
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireCtx();

  // The OAuth callback redirects here with the outcome, because it is a
  // top-level browser navigation and has no other way to report back.
  const params = await searchParams;
  const oauthError = params['error'];
  const justConnected = params['connected'];

  const [integrations, jobs] = await Promise.all([listIntegrations(ctx), listSyncJobs(ctx)]);

  const grouped = integrations.reduce<Record<string, typeof integrations>>((acc, row) => {
    (acc[row.kind] ??= []).push(row);
    return acc;
  }, {});

  const connected = integrations.filter((i) => i.status === 'connected' || i.status === 'demo').length;

  return (
    <PageShell>
      {oauthError && (
        <div
          role="alert"
          className="mb-5 rounded-[var(--radius-md)] border border-danger/35 bg-danger-subtle px-4 py-3 text-sm text-danger-text"
        >
          <strong className="font-medium">Connection failed.</strong> {oauthError}
        </div>
      )}
      {justConnected && !oauthError && (
        <div className="mb-5 rounded-[var(--radius-md)] border border-success/30 bg-success-subtle px-4 py-3 text-sm text-success-text">
          <strong className="font-medium">{titleCase(justConnected.replace(/_/g, ' '))} connected.</strong>{' '}
          Figbolt can now create events and send invitations from this account.
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-text">Integrations</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted text-pretty">
            {connected} of {integrations.length} connected. Every connector has a real provider
            interface and a demo adapter, so the ingestion pipeline is exercised either way.
          </p>
        </div>
        <Badge tone={env.INTEGRATION_MODE === 'live' ? 'success' : 'accent'} size="md">
          {env.INTEGRATION_MODE === 'live' ? 'Live mode' : 'Demo mode'}
        </Badge>
      </div>

      {env.INTEGRATION_MODE !== 'live' && (
        <Card className="mt-5 border-accent-border bg-accent-subtle">
          <CardBody className="flex gap-2.5 pt-3.5">
            <Shield className="mt-0.5 size-4 shrink-0 text-accent" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-accent-text">
                Running in demo mode — nothing leaves this machine
              </p>
              <p className="mt-1 text-2xs leading-relaxed text-accent-text/85 text-pretty">
                Connectors serve fixture data through the same interfaces a live adapter implements,
                so resolution, extraction, sync bookkeeping and error handling all run for real. To go
                live, set <code className="font-mono">INTEGRATION_MODE=live</code> plus the OAuth
                credentials for the providers you want, then connect them here.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="mt-6 space-y-7">
        {Object.entries(grouped)
          .sort(([a], [b]) => {
            const ia = KIND_ORDER.indexOf(a);
            const ib = KIND_ORDER.indexOf(b);
            // Unlisted kinds fall to the end, alphabetically among themselves.
            if (ia === -1 && ib === -1) return a.localeCompare(b);
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          })
          .map(([kind, rows]) => (
          <section key={kind}>
            <SectionLabel>{KIND_LABEL[kind] ?? titleCase(kind)}</SectionLabel>
            <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
              {rows.map((row) => (
                <Card key={row.provider} className="overflow-hidden">
                  <div className="px-4 pt-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusDot
                            tone={
                              row.status === 'connected'
                                ? 'success'
                                : row.status === 'demo'
                                  ? 'accent'
                                  : row.status === 'error'
                                    ? 'danger'
                                    : row.status === 'syncing'
                                      ? 'warning'
                                      : 'neutral'
                            }
                            label={titleCase(row.status)}
                            pulse={row.status === 'syncing'}
                          />
                          <h3 className="min-w-0 truncate text-sm font-medium text-text">
                            {row.name}
                          </h3>
                          {row.status === 'demo' && <Badge tone="accent">Demo</Badge>}
                          {row.status === 'connected' && <Badge tone="success">Live</Badge>}
                          {row.status === 'error' && <Badge tone="danger">Error</Badge>}
                          {/* What this connector can actually do, stated rather
                              than implied by the presence of a Connect button. */}
                          <Badge
                            tone={LEVEL_NOTE[row.level]?.tone ?? 'neutral'}
                            title={LEVEL_NOTE[row.level]?.hint}
                          >
                            {LEVEL_NOTE[row.level]?.label ?? row.level}
                          </Badge>
                          {row.auth === 'api_key' && <Badge tone="outline">API key</Badge>}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted text-pretty">
                          {row.description}
                        </p>
                      </div>
                    </div>

                    <ul className="mt-2.5 space-y-1">
                      {row.capabilities.slice(0, 3).map((capability) => (
                        <li
                          key={capability}
                          className="flex gap-2 text-2xs leading-relaxed text-text-subtle"
                        >
                          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-text-subtle" />
                          <span>{capability}</span>
                        </li>
                      ))}
                    </ul>

                    {row.connectorStatus === 'missing_credentials' && (
                      <p className="mt-2.5 flex items-start gap-1.5 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-subtle px-2 py-1.5 text-[10px] leading-relaxed text-warning-text">
                        <AlertTriangle className="mt-px size-3 shrink-0" />
                        <span>
                          Live mode is on but {row.missingEnv.join(' and ')}{' '}
                          {row.missingEnv.length === 1 ? 'is' : 'are'} not set.
                        </span>
                      </p>
                    )}

                    {row.lastError && (
                      <p className="mt-2.5 rounded-[var(--radius-sm)] border border-danger/25 bg-danger-subtle px-2 py-1.5 font-mono text-[10px] break-words text-danger-text">
                        {row.lastError}
                      </p>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border bg-bg-subtle px-4 py-2.5">
                    <span className="text-2xs text-text-subtle">
                      {row.lastSyncedAt ? `Synced ${relativeTime(row.lastSyncedAt)}` : 'Never synced'}
                      {row.recordsSynced > 0 && ` · ${number(row.recordsSynced)} records`}
                    </span>
                    <div className="ml-auto">
                      <IntegrationCardActions
                        provider={row.provider}
                        name={row.name}
                        connected={row.status === 'connected' || row.status === 'demo'}
                        docsUrl={row.docsUrl}
                      />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>
          ))}
      </div>

      {jobs.length > 0 && (
        <Card className="mt-7">
          <CardHeader>
            <div>
              <CardTitle>Sync history</CardTitle>
              <p className="mt-0.5 text-2xs text-text-subtle">
                Every sync writes a job row with retry state, so a failing connector is visible rather
                than silent.
              </p>
            </div>
          </CardHeader>
          <CardBody className="pt-0">
            <ul className="space-y-1.5">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] bg-bg-subtle px-2.5 py-1.5"
                >
                  <StatusDot
                    tone={
                      job.status === 'succeeded'
                        ? 'success'
                        : job.status === 'failed'
                          ? 'danger'
                          : job.status === 'rate_limited'
                            ? 'warning'
                            : 'accent'
                    }
                    label={job.status}
                  />
                  <span className="text-xs font-medium text-text">{titleCase(job.provider)}</span>
                  <Badge tone="outline">{job.kind}</Badge>
                  <span className="text-2xs text-text-subtle">
                    {job.recordsCreated} created / {job.recordsProcessed} processed
                  </span>
                  {job.attempt > 0 && <Badge tone="warning">attempt {job.attempt + 1}</Badge>}
                  <span className="ml-auto text-2xs text-text-subtle">
                    {job.finishedAt ? relativeTime(job.finishedAt) : 'running'}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </PageShell>
  );
}
