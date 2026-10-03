/*
 * Figbolt service worker.
 *
 * Deliberately narrow. It does two things:
 *
 *   1. When a page navigation fails because the device is offline, it serves
 *      a static "you're offline" page instead of the browser's error screen.
 *   2. It caches Next's fingerprinted build assets (/_next/static/...), which
 *      are immutable and contain no customer data, so the app shell loads fast.
 *
 * It never caches a page, an API response, a server action or an RSC payload.
 * A CRM's pages are customer data behind a session: cached, they would stay
 * readable on a lost or shared phone after sign-out, and could be served to the
 * next person who signs in on the same device. Network-only is the safe
 * default; anything cached here must be safe to show to anyone holding the
 * phone.
 *
 * Bump VERSION to drop every cache from previous releases on activate.
 */

const VERSION = 'v1';
const STATIC_CACHE = `figbolt-static-${VERSION}`;
const OFFLINE_CACHE = `figbolt-offline-${VERSION}`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      // `reload` bypasses the HTTP cache so a stale copy is never pinned.
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, OFFLINE_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith('figbolt-') && !keep.has(key)) await caches.delete(key);
      }
      // Starts the navigation request in parallel with worker boot-up.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page loads: always the network. The offline page only on a network failure,
  // never on an HTTP error — a 500 or a redirect to /login must reach the user.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) return preloaded;
          return await fetch(request);
        } catch {
          const offline = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
          return offline ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Fingerprinted build output: the file name changes whenever the content
  // does, so a cached copy can never be stale.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }

  // Everything else — API routes, RSC payloads, images, uploads — is left to
  // the browser and the network, untouched.
});
