'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CompanyContext } from '@/db/schema';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  SectionLabel,
  Textarea,
} from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { completeOnboardingAction, createWorkspaceAction, seedDemoAction } from './actions';
import { ArrowRight, CheckCircle, NavIcon, Sparkle } from '@/components/layout/icons';
import { cn } from '@/lib/utils';
import { LogoTile } from '@/components/brand/logo';

/**
 * Onboarding.
 *
 * Eight steps, but only two are blocking: naming the workspace and describing
 * the company. Everything else can be skipped and finished later, because the
 * fastest path to a useful CRM is getting real interactions flowing — not
 * completing a form.
 */

type Step = {
  id: string;
  title: string;
  blurb: string;
  optional?: boolean;
};

const STEPS: Step[] = [
  { id: 'workspace', title: 'Create your workspace', blurb: 'A name and a URL slug.' },
  { id: 'company', title: 'Describe your company', blurb: 'This becomes the context every agent reasons with.' },
  { id: 'connect', title: 'Connect email & calendar', blurb: 'Where the CRM populates itself from.', optional: true },
  { id: 'import', title: 'Import existing CRM data', blurb: 'HubSpot, Salesforce or a CSV.', optional: true },
  { id: 'pipeline', title: 'Configure your pipeline', blurb: 'Stages and entry criteria.', optional: true },
  { id: 'team', title: 'Invite your team', blurb: 'Needs an outbound email provider.', optional: true },
  { id: 'permissions', title: 'Set AI permissions', blurb: 'What agents may do unattended.', optional: true },
  { id: 'insights', title: 'Generate first insights', blurb: 'Bolt reads what it has and reports back.' },
];

export function OnboardingFlow({
  userName,
  existing,
}: {
  userName: string;
  existing: { id: string; name: string; step: string; companyContext: CompanyContext } | null;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [stepIndex, setStepIndex] = React.useState(() => {
    if (!existing) return 0;
    const found = STEPS.findIndex((s) => s.id === existing.step);
    return found > 0 ? found : 1;
  });

  const [workspaceId, setWorkspaceId] = React.useState(existing?.id ?? null);
  const [name, setName] = React.useState(existing?.name ?? '');
  const [context, setContext] = React.useState<CompanyContext>(existing?.companyContext ?? {});
  const [pending, setPending] = React.useState(false);

  const step = STEPS[stepIndex]!;

  const createWorkspace = async () => {
    setPending(true);
    const result = await createWorkspaceAction({ name });
    setPending(false);

    if (!result.ok) {
      toast({ title: 'Could not create the workspace', description: result.error, tone: 'error' });
      return;
    }
    if (result.data) setWorkspaceId(result.data.id);
    setStepIndex(1);
  };

  const saveCompany = async () => {
    if (!workspaceId) return;
    setPending(true);
    const result = await completeOnboardingAction({
      workspaceId,
      step: 'connect',
      companyContext: context,
    });
    setPending(false);

    if (!result.ok) {
      toast({ title: 'Could not save', description: result.error, tone: 'error' });
      return;
    }
    setStepIndex(2);
  };

  const finish = async () => {
    if (!workspaceId) return;
    setPending(true);
    const result = await completeOnboardingAction({ workspaceId, step: 'complete', complete: true });
    setPending(false);

    if (!result.ok) {
      toast({ title: 'Could not finish setup', description: result.error, tone: 'error' });
      return;
    }
    router.push('/home');
  };

  const loadDemo = async () => {
    setPending(true);
    const result = await seedDemoAction();
    setPending(false);

    if (!result.ok) {
      toast({ title: 'Could not load the demo workspace', description: result.error, tone: 'error' });
      return;
    }
    toast({ title: 'Demo workspace loaded', tone: 'success' });
    router.push('/home');
  };

  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-6xl gap-8 px-5 py-10 lg:grid-cols-[260px_minmax(0,1fr)] lg:py-16">
      {/* ── Step rail ─────────────────────────────────────────────────── */}
      <aside className="min-w-0">
        <div className="flex items-center gap-2.5">
          <LogoTile className="size-7" />
          <span className="text-sm font-semibold tracking-tight text-text">Figbolt</span>
        </div>

        <p className="mt-6 text-sm text-text-muted">
          Welcome, {userName.split(' ')[0]}. Two steps are required; the rest can wait.
        </p>

        <ol className="mt-5 space-y-0.5">
          {STEPS.map((item, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  // Only let people jump to steps they have already reached.
                  disabled={i > stepIndex || (i > 0 && !workspaceId)}
                  onClick={() => setStepIndex(i)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors',
                    active && 'bg-surface shadow-[var(--shadow-sm)]',
                    !active && i <= stepIndex && 'hover:bg-bg-muted',
                    i > stepIndex && 'opacity-45',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                      done
                        ? 'bg-success text-white'
                        : active
                          ? 'bg-accent text-white'
                          : 'bg-bg-muted text-text-subtle',
                    )}
                  >
                    {done ? '✓' : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'text-xs',
                          active ? 'font-medium text-text' : 'text-text-muted',
                        )}
                      >
                        {item.title}
                      </span>
                      {item.optional && <Badge tone="neutral">optional</Badge>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <Card className="mt-6 border-accent-border bg-accent-subtle">
          <CardBody className="pt-3.5">
            <p className="text-xs font-semibold text-accent-text">Just exploring?</p>
            <p className="mt-1 text-2xs leading-relaxed text-accent-text/85 text-pretty">
              Load a seeded demo workspace: 28 accounts, 36 deals and 55 recorded meetings, with all
              AI memory derived by the real pipeline.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2.5 w-full"
              onClick={loadDemo}
              disabled={pending}
            >
              {pending && <Spinner className="size-3" />}
              Use the demo workspace
            </Button>
          </CardBody>
        </Card>
      </aside>

      {/* ── Step body ─────────────────────────────────────────────────── */}
      <main className="min-w-0">
        <p className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">
          Step {stepIndex + 1} of {STEPS.length}
        </p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-text text-balance">
          {step.title}
        </h1>
        <p className="mt-1.5 text-sm text-text-muted text-pretty">{step.blurb}</p>

        <div className="mt-6 max-w-2xl">
          {step.id === 'workspace' && (
            <Card>
              <CardBody className="space-y-4 pt-4">
                <Field label="Workspace name" hint="Usually your company name.">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Northwind Labs"
                    autoFocus
                  />
                </Field>
                <Button
                  variant="primary"
                  size="lg"
                  onClick={createWorkspace}
                  disabled={pending || name.trim().length < 2}
                >
                  {pending && <Spinner className="size-4" />}
                  Create workspace
                  <ArrowRight />
                </Button>
              </CardBody>
            </Card>
          )}

          {step.id === 'company' && (
            <Card>
              <CardBody className="space-y-4 pt-4">
                <p className="rounded-[var(--radius-md)] border border-accent-border bg-accent-subtle px-3 py-2 text-2xs leading-relaxed text-accent-text text-pretty">
                  These answers become trusted, organisation-level context in every prompt. They are
                  the difference between generic AI output and output that sounds like your company.
                </p>

                {(
                  [
                    {
                      key: 'whatWeSell' as const,
                      label: 'What does your company sell?',
                      placeholder: 'An operations workflow platform that replaces spreadsheet-and-email processes…',
                    },
                    {
                      key: 'idealCustomer' as const,
                      label: 'Who is your ideal customer?',
                      placeholder: 'Companies of 200–5,000 employees with a dedicated operations team…',
                    },
                    {
                      key: 'qualificationCriteria' as const,
                      label: 'What counts as a qualified opportunity?',
                      placeholder: 'A named owner with real pain, 50+ seats, a budget holder identified…',
                    },
                    {
                      key: 'differentiators' as const,
                      label: 'What makes you different?',
                      placeholder: 'Full audit trail by default, no data migration, ops-configurable…',
                    },
                  ]
                ).map((field) => (
                  <Field key={field.key} label={field.label}>
                    <Textarea
                      rows={2}
                      value={(context[field.key] as string) ?? ''}
                      onChange={(e) => setContext({ ...context, [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      className="text-xs leading-relaxed"
                    />
                  </Field>
                ))}

                <Field label="Competitors" hint="Comma-separated. Used to detect mentions in conversations.">
                  <Input
                    value={(context.competitors ?? []).join(', ')}
                    onChange={(e) =>
                      setContext({
                        ...context,
                        competitors: e.target.value.split(/\s*,\s*/).filter(Boolean),
                      })
                    }
                    placeholder="Vantage Systems, Coreflow"
                  />
                </Field>

                <Button variant="primary" size="lg" onClick={saveCompany} disabled={pending}>
                  {pending && <Spinner className="size-4" />}
                  Save and continue
                  <ArrowRight />
                </Button>
              </CardBody>
            </Card>
          )}

          {step.id === 'connect' && (
            <StepPlaceholder
              icon="plug"
              title="Connect email and calendar"
              body="This is where the CRM stops needing manual entry. Bolt reads mail and meetings, resolves them to accounts, and extracts commitments, objections and product requests automatically."
              actionLabel="Open Integrations"
              actionHref="/integrations"
              onSkip={() => setStepIndex(3)}
            />
          )}

          {step.id === 'import' && (
            <StepPlaceholder
              icon="building"
              title="Import existing CRM data"
              body="HubSpot and Salesforce connectors import companies, contacts and deals, then keep them in sync. Nothing is required here — Bolt builds its own picture from interactions regardless."
              actionLabel="Open Integrations"
              actionHref="/integrations"
              onSkip={() => setStepIndex(4)}
            />
          )}

          {step.id === 'pipeline' && (
            <StepPlaceholder
              icon="target"
              title="Configure your pipeline"
              body="A default five-stage pipeline is created with entry criteria on each stage. Those criteria are used by the AI when it checks whether a deal is sitting in the right place."
              actionLabel="Open Deals"
              actionHref="/opportunities"
              onSkip={() => setStepIndex(5)}
            />
          )}

          {step.id === 'team' && (
            <StepPlaceholder
              icon="users"
              title="Invite your team"
              body="Invitations need an outbound email provider. This deployment uses the console provider, which stores messages and sends nothing — a deliberate default so a demo cannot email real people."
              actionLabel="Open Team settings"
              actionHref="/settings/team"
              onSkip={() => setStepIndex(6)}
            />
          )}

          {step.id === 'permissions' && (
            <StepPlaceholder
              icon="bot"
              title="Set AI permissions"
              body="Agents start able to read and analyse freely. Anything that changes data or reaches a customer is held for approval. You can loosen that per risk class, and grant a specific agent autonomous sending."
              actionLabel="Open AI settings"
              actionHref="/settings/ai"
              onSkip={() => setStepIndex(7)}
            />
          )}

          {step.id === 'insights' && (
            <Card>
              <CardBody className="pt-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
                    <Sparkle className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">You&rsquo;re set up</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-muted text-pretty">
                      Bolt will build customer memory as interactions arrive. Cross-account patterns
                      appear once there is enough closed history to compare — detectors that lack a
                      large enough cohort report nothing rather than a hedged guess.
                    </p>

                    <SectionLabel className="mt-4">What happens next</SectionLabel>
                    <ul className="mt-1.5 space-y-1.5">
                      {[
                        'Emails and meetings are resolved to accounts and deals automatically.',
                        'Commitments, objections and product requests are extracted with their source quotes.',
                        'Deal health is recomputed with a full, checkable rationale.',
                        'The Inbox fills with what needs a decision, and why it matters.',
                      ].map((line) => (
                        <li key={line} className="flex gap-2 text-xs text-text-muted text-pretty">
                          <CheckCircle className="mt-0.5 size-3.5 shrink-0 text-success" />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>

                    <Button variant="primary" size="lg" className="mt-5" onClick={finish} disabled={pending}>
                      {pending && <Spinner className="size-4" />}
                      Go to Figbolt
                      <ArrowRight />
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}

function StepPlaceholder({
  icon,
  title,
  body,
  actionLabel,
  actionHref,
  onSkip,
}: {
  icon: Parameters<typeof NavIcon>[0]['name'];
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
  onSkip: () => void;
}) {
  return (
    <Card>
      <CardBody className="pt-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-subtle">
            <NavIcon name={icon} className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-text-muted text-pretty">{body}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <a
                href={actionHref}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-surface px-3 text-xs font-medium text-text shadow-[var(--shadow-sm)] hover:bg-surface-hover"
              >
                {actionLabel}
              </a>
              <Button variant="ghost" size="sm" onClick={onSkip}>
                Skip for now
                <ArrowRight />
              </Button>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
