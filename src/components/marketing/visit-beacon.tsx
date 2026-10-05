'use client';

import * as React from 'react';

/**
 * Counts one page view on a public page. No cookie, no storage, no identifier
 * on the device — the server derives a same-day-only visitor hash. Production
 * only, so local development does not pollute the numbers.
 */
export function VisitBeacon({ path }: { path: string }) {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    const body = JSON.stringify({ path, referrer: document.referrer || null });
    const sent = navigator.sendBeacon?.('/api/p', new Blob([body], { type: 'application/json' }));
    if (!sent) {
      void fetch('/api/p', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
    }
  }, [path]);
  return null;
}
