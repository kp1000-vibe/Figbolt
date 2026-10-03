'use client';

import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import {
  connectIntegrationAction,
  disconnectIntegrationAction,
  syncIntegrationAction,
} from './actions';
import { ArrowUpRight, Refresh } from '@/components/layout/icons';

export function IntegrationCardActions({
  provider,
  name,
  connected,
  docsUrl,
}: {
  provider: string;
  name: string;
  connected: boolean;
  docsUrl: string;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const { toast } = useToast();

  const run = async (kind: 'connect' | 'disconnect' | 'sync') => {
    setPending(kind);
    const result =
      kind === 'connect'
        ? await connectIntegrationAction(provider)
        : kind === 'disconnect'
          ? await disconnectIntegrationAction(provider)
          : await syncIntegrationAction(provider);
    // A live connector answers with a consent URL instead of a result. Leave
    // `pending` set so the button stays busy while the browser navigates away.
    const redirectTo =
      result.ok && kind === 'connect'
        ? (result as { data?: { redirectTo?: string } }).data?.redirectTo
        : undefined;
    if (redirectTo) {
      window.location.href = redirectTo;
      return;
    }

    setPending(null);

    toast(
      result.ok
        ? { title: `${name}: ${kind === 'sync' ? 'sync complete' : kind + 'ed'}`, description: result.message, tone: 'success' }
        : { title: `Could not ${kind} ${name}`, description: result.error, tone: 'error' },
    );
  };

  return (
    <div className="flex items-center gap-1">
      <a
        href={docsUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex min-h-6 items-center gap-1 px-1.5 text-2xs text-text-subtle hover:text-accent-text"
        title={`${name} API documentation`}
      >
        Docs
        <ArrowUpRight className="size-3" />
      </a>

      {connected ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => run('sync')} disabled={pending !== null}>
            {pending === 'sync' ? <Spinner className="size-3" /> : <Refresh />}
            Sync
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run('disconnect')}
            disabled={pending !== null}
          >
            {pending === 'disconnect' && <Spinner className="size-3" />}
            Disconnect
          </Button>
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => run('connect')} disabled={pending !== null}>
          {pending === 'connect' && <Spinner className="size-3" />}
          Connect
        </Button>
      )}
    </div>
  );
}
