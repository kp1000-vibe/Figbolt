'use client';

import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { ActionButtons } from '@/components/ai/action-buttons';
import { refreshAccountMemoryAction } from '@/app/actions';
import { Refresh } from '@/components/layout/icons';

export function AccountHeaderActions({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  const refresh = async () => {
    setPending(true);
    const result = await refreshAccountMemoryAction(accountId);
    setPending(false);
    toast(
      result.ok
        ? { title: result.message ?? 'Memory rebuilt.', tone: 'success' }
        : { title: 'Could not rebuild memory', description: result.error, tone: 'error' },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionButtons
        size="sm"
        actions={[
          { label: 'Draft email', kind: 'draft_email', payload: { purpose: 'check in' } },
          { label: 'Create task', kind: 'create_task', payload: { title: `Follow up with ${accountName}` } },
        ]}
        context={{ accountId }}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={refresh}
        disabled={pending}
        title="Recompute the customer memory and health score from current evidence"
      >
        {pending ? <Spinner className="size-3.5" /> : <Refresh />}
        Rebuild memory
      </Button>
    </div>
  );
}
