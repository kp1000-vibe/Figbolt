'use client';

import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { runAutomationAction, setAutomationEnabledAction } from './actions';
import { Pause, Play } from '@/components/layout/icons';

export function AutomationRowActions({
  automationId,
  enabled,
}: {
  automationId: string;
  enabled: boolean;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const { toast } = useToast();

  const run = async () => {
    setPending('run');
    const result = await runAutomationAction(automationId);
    setPending(null);
    toast(
      result.ok
        ? { title: 'Automation ran', description: result.message, tone: 'success' }
        : { title: 'Could not run it', description: result.error, tone: 'error' },
    );
  };

  const toggle = async () => {
    setPending('toggle');
    const result = await setAutomationEnabledAction(automationId, !enabled);
    setPending(null);
    toast(
      result.ok
        ? { title: enabled ? 'Automation paused.' : 'Automation enabled.', tone: 'success' }
        : { title: 'Could not update', description: result.error, tone: 'error' },
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant="secondary" size="sm" onClick={run} disabled={pending !== null}>
        {pending === 'run' ? <Spinner className="size-3" /> : <Play />}
        Test run
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        disabled={pending !== null}
        aria-label={enabled ? 'Pause automation' : 'Enable automation'}
        title={enabled ? 'Pause automation' : 'Enable automation'}
      >
        {pending === 'toggle' ? <Spinner className="size-3.5" /> : enabled ? <Pause /> : <Play />}
      </Button>
    </div>
  );
}
