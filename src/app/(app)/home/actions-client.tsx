'use client';

import { CardFooter } from '@/components/ui/primitives';
import { ActionButtons } from '@/components/ai/action-buttons';
import type { BriefingPriority } from '@/server/ai/briefing';

/** Footer action row for a briefing priority. */
export function HomeActions({ priority }: { priority: BriefingPriority }) {
  if (priority.actions.length === 0) return null;

  return (
    <CardFooter className="mt-3.5 bg-bg-subtle">
      <ActionButtons
        actions={priority.actions}
        context={{
          accountId: priority.accountId,
          opportunityId: priority.opportunityId,
        }}
      />
    </CardFooter>
  );
}
