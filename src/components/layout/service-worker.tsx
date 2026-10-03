'use client';

import * as React from 'react';

/**
 * Registers /sw.js — see public/sw.js for what it does and, more importantly,
 * what it refuses to cache.
 *
 * Production only. In development a service worker outlives code changes and
 * serves stale build assets, which looks exactly like hot reload being broken.
 * Registration waits for `load` so it never competes with the first paint.
 */
export function ServiceWorkerRegistration() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Not being installable is no reason to break the page.
      });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
