'use client';

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ActionButtons } from '@/components/ai/action-buttons';

/**
 * Turn an answer's recommendations into executable actions.
 *
 * The AI produces a title and a rationale but no tool binding, so this maps a
 * recommendation onto a concrete tool by reading its intent — and passes the
 * entities the answer already resolved as context, so "draft a follow-up"
 * knows which account it means without a second round of guessing.
 */
export function AskActions({
  actions,
  entities,
}: {
  actions: { title: string; why: string }[];
  entities: { type: string; id?: string; label: string }[];
}) {
  const accountId = entities.find((e) => e.type === 'account')?.id;
  const opportunityId = entities.find((e) => e.type === 'opportunity')?.id;
  const contactId = entities.find((e) => e.type === 'contact')?.id;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Act on this</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">
            Drafts are saved for review. Nothing is sent without your approval.
          </p>
        </div>
      </CardHeader>
      <CardBody className="pt-0">
        <ul className="space-y-3">
          {actions.map((action, i) => (
            <li key={i} className="min-w-0">
              <p className="text-xs font-medium text-text text-pretty">{action.title}</p>
              <p className="mt-0.5 text-2xs text-text-muted text-pretty">{action.why}</p>
              <div className="mt-1.5">
                <ActionButtons
                  size="xs"
                  actions={inferActions(action.title)}
                  context={{ accountId, opportunityId, contactId }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Map a recommendation's wording onto tools.
 *
 * Deliberately conservative: an unrecognised recommendation offers "Create
 * task" rather than guessing at something with side effects. Better to make
 * the user do one extra click than to bind "send the contract" to send_email.
 */
function inferActions(title: string): { label: string; kind: string; payload?: Record<string, unknown> }[] {
  const t = title.toLowerCase();

  if (/\b(email|follow[- ]?up|reply|reach out|re-?engage|check in|nudge)\b/.test(t)) {
    return [
      { label: 'Draft email', kind: 'draft_email', payload: { purpose: title } },
      { label: 'Create task', kind: 'create_task', payload: { title } },
    ];
  }
  if (/\b(call|meeting|schedule|demo|session|workshop)\b/.test(t)) {
    return [
      { label: 'Schedule', kind: 'schedule_meeting' },
      { label: 'Create task', kind: 'create_task', payload: { title } },
    ];
  }
  return [{ label: 'Create task', kind: 'create_task', payload: { title } }];
}
