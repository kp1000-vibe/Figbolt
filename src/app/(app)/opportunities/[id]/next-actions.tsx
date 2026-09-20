'use client';

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ActionButtons } from '@/components/ai/action-buttons';
import type { RecommendedAction } from '@/db/schema';

/**
 * Next best actions.
 *
 * Each is derived from a concrete gap — an overdue commitment, an absent
 * economic buyer, an unresolved blocker — so the "why" is checkable rather
 * than motivational.
 */
export function NextActions({
  actions,
  accountId,
  opportunityId,
}: {
  actions: RecommendedAction[];
  accountId: string;
  opportunityId: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Next best actions</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">Ordered by what is most likely to unblock the deal</p>
        </div>
      </CardHeader>
      <CardBody className="pt-0">
        {actions.length === 0 ? (
          <p className="text-xs text-text-subtle">
            Nothing pressing. No overdue commitments, no unresolved high-severity objections.
          </p>
        ) : (
          <ol className="space-y-3.5">
            {actions.map((action, i) => (
              <li key={i} className="min-w-0">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[10px] font-bold text-accent-text">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-text text-pretty">{action.title}</p>
                    <p className="mt-0.5 text-2xs leading-relaxed text-text-muted text-pretty">
                      {action.why}
                    </p>
                    <div className="mt-1.5">
                      <ActionButtons
                        size="xs"
                        actions={
                          action.action
                            ? [{ label: labelFor(action.action.kind), kind: action.action.kind, payload: action.action.payload }]
                            : [{ label: 'Create task', kind: 'create_task', payload: { title: action.title } }]
                        }
                        context={{ accountId, opportunityId }}
                      />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function labelFor(kind: string): string {
  switch (kind) {
    case 'draft_email':
      return 'Draft email';
    case 'create_task':
      return 'Create task';
    case 'schedule_meeting':
      return 'Schedule';
    case 'open_record':
      return 'Open';
    case 'update_stage':
      return 'Update stage';
    default:
      return 'Run';
  }
}
