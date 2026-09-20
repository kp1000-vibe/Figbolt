'use client';

import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { recomputeInsightsAction } from '@/app/actions';
import { Refresh } from '@/components/layout/icons';

export function RecomputeInsights() {
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = await recomputeInsightsAction();
        setPending(false);
        toast(
          result.ok
            ? { title: result.message ?? 'Recomputed.', tone: 'success' }
            : { title: 'Could not recompute', description: result.error, tone: 'error' },
        );
      }}
    >
      {pending ? <Spinner className="size-3.5" /> : <Refresh />}
      Recompute patterns
    </Button>
  );
}
