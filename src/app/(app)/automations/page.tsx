import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { describeAutomationTrigger, describeCondition, listAutomations } from '@/server/automations/engine';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  SectionLabel,
  StatusDot,
} from '@/components/ui/primitives';
import { AutomationRowActions } from './row-actions';
import { NavIcon, Plus } from '@/components/layout/icons';
import { number, relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Automations' };

const ACTION_LABEL: Record<string, string> = {
  ask_ai: 'Ask AI',
  update_record: 'Update record',
  create_task: 'Create task',
  draft_email: 'Draft email',
  send_slack: 'Slack notification',
  run_agent: 'Run agent',
  call_webhook: 'Call webhook',
  add_note: 'Add note',
};

export default async function AutomationsPage() {
  const ctx = await requireCtx();
  const automations = await listAutomations(ctx);

  return (
    <PageShell>
      <PageHeader
        title="Automations"
        description="Trigger, conditions, actions. Actions run through the same permission and approval model as agents — config is not a way around it."
        actions={
          <Link
            href="/automations/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] bg-accent px-3.5 text-sm font-medium text-white shadow-[var(--shadow-sm)] hover:bg-accent-hover"
          >
            <Plus className="size-4" />
            New automation
          </Link>
        }
      />

      {automations.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="workflow" />}
          title="No automations yet"
          description="Automations react to events — a meeting completing, a deal going quiet, a commitment coming due — and run a short chain of actions."
          action={
            <Link
              href="/automations/new"
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-surface px-3 text-xs font-medium text-text shadow-[var(--shadow-sm)] hover:bg-surface-hover"
            >
              <Plus className="size-3.5" />
              Create one
            </Link>
          }
        />
      ) : (
        <ul className="mt-6 space-y-3">
          {automations.map((automation) => (
            <Card as="li" key={automation.id} className="overflow-hidden">
              <div className="px-4 pt-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot
                        tone={automation.enabled ? 'success' : 'neutral'}
                        label={automation.enabled ? 'Enabled' : 'Paused'}
                      />
                      <h3 className="min-w-0 truncate text-sm font-medium text-text">
                        {automation.name}
                      </h3>
                      {automation.errorCount > 0 && (
                        <Badge tone="danger">{automation.errorCount} failures</Badge>
                      )}
                    </div>
                    {automation.description && (
                      <p className="mt-1 text-xs leading-relaxed text-text-muted text-pretty">
                        {automation.description}
                      </p>
                    )}
                  </div>

                  <AutomationRowActions
                    automationId={automation.id}
                    enabled={automation.enabled}
                  />
                </div>

                {/* Trigger → conditions → actions, read left to right. */}
                <div className="mt-3 space-y-2">
                  <Row label="When">{describeAutomationTrigger(automation.trigger)}</Row>
                  <Row label="If">{describeCondition(automation.conditions)}</Row>
                  <Row label="Then">
                    <span className="flex flex-wrap gap-1.5">
                      {automation.actions.map((action) => (
                        <Badge
                          key={action.id}
                          tone={
                            action.riskLevel === 'high'
                              ? 'danger'
                              : action.riskLevel === 'medium'
                                ? 'warning'
                                : 'neutral'
                          }
                          title={`${action.riskLevel} risk`}
                        >
                          {ACTION_LABEL[action.kind] ?? titleCase(action.kind)}
                        </Badge>
                      ))}
                    </span>
                  </Row>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-bg-subtle px-4 py-2 text-2xs text-text-subtle">
                <span>{number(automation.runCount)} runs</span>
                <span>
                  Last {automation.lastRunAt ? relativeTime(automation.lastRunAt) : 'never'}
                </span>
                {automation.enabled && automation.nextRunAt && (
                  <span>Next {relativeTime(automation.nextRunAt)}</span>
                )}
                {automation.createdByName && <span>Created by {automation.createdByName}</span>}
              </div>
            </Card>
          ))}
        </ul>
      )}

      <Card className="mt-6 border-accent-border bg-accent-subtle">
        <CardBody className="pt-4">
          <p className="text-xs font-semibold text-accent-text">How conditions are evaluated</p>
          <p className="mt-1.5 text-2xs leading-relaxed text-accent-text/85 text-pretty">
            Conditions are a typed expression tree evaluated in application code against the facts the
            trigger provided. They are never compiled to SQL or evaluated as code, so a condition
            cannot read data the trigger did not already supply — and cannot be used to reach another
            workspace.
          </p>
        </CardBody>
      </Card>
    </PageShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="w-10 shrink-0 pt-0.5 text-2xs font-semibold tracking-wide text-text-subtle uppercase">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-xs text-text-muted text-pretty">{children}</span>
    </div>
  );
}
