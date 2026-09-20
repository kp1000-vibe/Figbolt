import { eq } from 'drizzle-orm';
import { requireCtx } from '@/server/context';
import { workspaces } from '@/db/schema';
import { env } from '@/lib/env';
import { Badge, Card, CardBody, CardHeader, CardTitle, DetailRow } from '@/components/ui/primitives';
import { CompanyContextForm } from './company-context-form';
import { shortDate } from '@/lib/utils';

export const metadata = { title: 'Workspace settings' };

export default async function WorkspaceSettingsPage() {
  const ctx = await requireCtx();

  const [workspace] = await ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);

  if (!workspace) return null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Company context</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              This is trusted, organisation-level context every agent and answer is grounded in. It is
              the difference between generic output and output that sounds like your company.
            </p>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <CompanyContextForm
            initial={workspace.companyContext ?? {}}
            canEdit={ctx.session.permissions.includes('workspace:manage')}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          <dl>
            <DetailRow label="Name">{workspace.name}</DetailRow>
            <DetailRow label="Slug">
              <span className="font-mono">{workspace.slug}</span>
            </DetailRow>
            <DetailRow label="Domain">{workspace.domain ?? '—'}</DetailRow>
            <DetailRow label="Created">{shortDate(workspace.createdAt)}</DetailRow>
            <DetailRow label="Onboarding">
              {workspace.onboardingCompletedAt
                ? `completed ${shortDate(workspace.onboardingCompletedAt)}`
                : workspace.onboardingStep}
            </DetailRow>
            <DetailRow label="Type">
              {workspace.isDemo ? <Badge tone="accent">Demo workspace</Badge> : 'Production'}
            </DetailRow>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Runtime configuration</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              Read from the environment. Change these in <code className="font-mono">.env</code>.
            </p>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <dl>
            <DetailRow label="AI provider">
              <span className="font-mono">{env.AI_PROVIDER}</span>
              {env.AI_PROVIDER === 'local' && (
                <Badge tone="accent" className="ml-1.5">
                  offline engine
                </Badge>
              )}
            </DetailRow>
            <DetailRow label="Embeddings">
              <span className="font-mono">
                {env.EMBEDDING_PROVIDER} · {env.EMBEDDING_DIMENSIONS}d
              </span>
            </DetailRow>
            <DetailRow label="Database">
              <span className="font-mono">{env.DATABASE_URL ? 'PostgreSQL' : 'PGlite (embedded)'}</span>
            </DetailRow>
            <DetailRow label="Integrations">
              <span className="font-mono">{env.INTEGRATION_MODE}</span>
            </DetailRow>
            <DetailRow label="Email delivery">
              <span className="font-mono">{env.EMAIL_PROVIDER}</span>
              {env.EMAIL_PROVIDER === 'console' && (
                <Badge tone="neutral" className="ml-1.5">
                  nothing is sent
                </Badge>
              )}
            </DetailRow>
            <DetailRow label="Job runner">
              <span className="font-mono">{env.JOB_RUNNER}</span>
            </DetailRow>
          </dl>

          {env.AI_PROVIDER === 'local' && (
            <p className="mt-3 rounded-[var(--radius-md)] border border-accent-border bg-accent-subtle px-3 py-2 text-2xs leading-relaxed text-accent-text text-pretty">
              The offline engine performs real retrieval-grounded work with no API key and no network:
              extractive question answering with citations, modal-verb commitment detection, and
              cue-based objection and signal classification. Set{' '}
              <code className="font-mono">AI_PROVIDER</code> to anthropic, openai or google for
              fluent synthesis — no call site above the provider layer changes.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
