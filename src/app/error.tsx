'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/primitives';

/**
 * Root error boundary.
 *
 * Shows a recoverable message and a reset, never a stack trace — the digest is
 * enough to correlate with the server log, and the underlying error may carry
 * customer data.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[boundary]', error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="font-mono text-xs tracking-wide text-danger-text uppercase">Error</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-text">
        Something broke on this page
      </h1>
      <p className="mt-1.5 max-w-md text-sm text-text-muted text-pretty">
        The error was logged. Retrying often works — if it does not, the page may be relying on data
        that has changed.
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-2xs text-text-subtle">Reference: {error.digest}</p>
      )}
      <div className="mt-6 flex gap-2">
        <Button variant="primary" size="md" onClick={reset}>
          Try again
        </Button>
        <Button variant="secondary" size="md" onClick={() => (window.location.href = '/home')}>
          Back to Home
        </Button>
      </div>
    </main>
  );
}
