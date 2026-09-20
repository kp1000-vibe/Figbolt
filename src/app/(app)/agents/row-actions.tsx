'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { runAgentAction } from '@/app/actions';
import { setAgentEnabledAction } from './actions';
import { Pause, Play } from '@/components/layout/icons';

export function AgentRowActions({ agentId, enabled }: { agentId: string; enabled: boolean }) {
  const [pending, setPending] = React.useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  const run = async () => {
    setPending('run');
    const result = await runAgentAction(agentId);
    setPending(null);

    if (result.ok) {
      toast({ title: result.message ?? 'Run complete.', tone: 'success' });
      if (result.data?.runId) router.push(`/agents/${agentId}/runs/${result.data.runId}`);
    } else {
      toast({ title: 'The run could not start', description: result.error, tone: 'error' });
    }
  };

  const toggle = async () => {
    setPending('toggle');
    const result = await setAgentEnabledAction(agentId, !enabled);
    setPending(null);
    toast(
      result.ok
        ? { title: enabled ? 'Agent paused.' : 'Agent enabled.', tone: 'success' }
        : { title: 'Could not update', description: result.error, tone: 'error' },
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant="secondary" size="sm" onClick={run} disabled={pending !== null || !enabled}>
        {pending === 'run' ? <Spinner className="size-3" /> : <Play />}
        Run now
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        disabled={pending !== null}
        aria-label={enabled ? 'Pause agent' : 'Enable agent'}
        title={enabled ? 'Pause agent' : 'Enable agent'}
      >
        {pending === 'toggle' ? <Spinner className="size-3.5" /> : enabled ? <Pause /> : <Play />}
      </Button>
    </div>
  );
}
