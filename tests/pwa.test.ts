import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import manifest from '@/app/manifest';
import nextConfig from '../next.config';
import { isPwaIconFile, PWA_ICON_PREFIX, PWA_ICONS, PWA_OFFLINE_URL, PWA_START_URL } from '@/lib/pwa';
import { MARK_BODY_PATH, MARK_LEAF_PATH } from '@/lib/brand-mark';

/**
 * The installable app, and the one way it could do real damage.
 *
 * Being installable is a nice-to-have. Not leaking is a requirement: a service
 * worker that cached pages would leave a workspace's customers readable on a
 * lost or shared phone after sign-out. So most of this file runs the real
 * public/sw.js against a fake browser and checks what it refuses to touch.
 */

const ORIGIN = 'https://figbolt.com';
const SW_SOURCE = readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');

type FakeRequest = { url: string; method: string; mode: string; cache?: string };

function request(url: string, init: Partial<FakeRequest> = {}): FakeRequest {
  return { url: new URL(url, ORIGIN).href, method: 'GET', mode: 'cors', ...init };
}

/** A minimal Cache Storage: cache name -> (url -> Response). */
function fakeCaches(fetchImpl: (req: FakeRequest) => Promise<Response>) {
  const store = new Map<string, Map<string, Response>>();
  const keyOf = (req: FakeRequest | string) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);

  const open = async (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name)!;
    return {
      match: async (req: FakeRequest | string) => entries.get(keyOf(req))?.clone(),
      put: async (req: FakeRequest | string, res: Response) => void entries.set(keyOf(req), res),
      add: async (req: FakeRequest) => void entries.set(keyOf(req), await fetchImpl(req)),
    };
  };

  return {
    store,
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
      match: async (req: FakeRequest | string, opts?: { cacheName?: string }) => {
        const names = opts?.cacheName ? [opts.cacheName] : [...store.keys()];
        for (const name of names) {
          const hit = store.get(name)?.get(keyOf(req));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    },
  };
}

/** Boots public/sw.js in a sandbox and returns handles to drive it. */
function bootWorker(network: (req: FakeRequest) => Promise<Response>) {
  const fetchSpy = vi.fn(network);
  const caches = fakeCaches(fetchSpy);
  const listeners: Record<string, (event: unknown) => void> = {};

  const self = {
    location: { origin: ORIGIN },
    registration: { navigationPreload: { enable: vi.fn(async () => {}) } },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
  };

  class SandboxRequest {
    url: string;
    method = 'GET';
    mode = 'cors';
    cache?: string;
    constructor(url: string, init?: { cache?: string }) {
      this.url = new URL(url, ORIGIN).href;
      this.cache = init?.cache;
    }
  }

  vm.runInNewContext(SW_SOURCE, {
    self,
    caches: caches.api,
    fetch: fetchSpy,
    Request: SandboxRequest,
    Response,
    URL,
    Set,
  });

  async function lifecycle(type: 'install' | 'activate') {
    let work: Promise<unknown> = Promise.resolve();
    listeners[type]!({ waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
  }

  /** Dispatches a fetch event; resolves to the response, or null if the worker let it through. */
  async function dispatch(req: FakeRequest, preload?: Response): Promise<Response | null> {
    let responded: Promise<Response> | null = null;
    listeners.fetch!({
      request: req,
      preloadResponse: Promise.resolve(preload),
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    return responded ? await responded : null;
  }

  return { caches, fetchSpy, self, lifecycle, dispatch };
}

const ok = (body: string, init: ResponseInit = {}) => {
  const res = new Response(body, { status: 200, ...init });
  // A same-origin response is type "basic" in a browser; undici reports "default".
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
};

async function installed(network: (req: FakeRequest) => Promise<Response>) {
  const worker = bootWorker(async (req) =>
    req.url.endsWith(PWA_OFFLINE_URL) ? ok('<h1>offline page</h1>') : network(req),
  );
  await worker.lifecycle('install');
  await worker.lifecycle('activate');
  return worker;
}

/** Every URL the worker has put in any cache. */
function cachedUrls(worker: ReturnType<typeof bootWorker>) {
  return [...worker.caches.store.values()].flatMap((entries) => [...entries.keys()]);
}

describe('service worker: what it refuses to cache', () => {
  it('never stores a page, an API response or an RSC payload, however many are fetched', async () => {
    const worker = await installed(async () => ok('<p>Acme Corp — $480,000 renewal</p>'));

    await worker.dispatch(request('/accounts/acme', { mode: 'navigate' }));
    await worker.dispatch(request('/opportunities', { mode: 'navigate' }));
    await worker.dispatch(request('/api/accounts'));
    await worker.dispatch(request('/accounts?_rsc=1x2y'));
    await worker.dispatch(request('/ask', { mode: 'navigate' }));

    // The offline page is the only document on the device.
    expect(cachedUrls(worker)).toEqual([`${ORIGIN}${PWA_OFFLINE_URL}`]);
  });

  it('leaves API, RSC, server-action and cross-origin requests entirely to the network', async () => {
    const worker = await installed(async () => ok('{}'));

    expect(await worker.dispatch(request('/api/accounts'))).toBeNull();
    expect(await worker.dispatch(request('/accounts?_rsc=abc'))).toBeNull();
    expect(await worker.dispatch(request('/accounts', { method: 'POST' }))).toBeNull();
    expect(await worker.dispatch(request('/home', { method: 'POST', mode: 'navigate' }))).toBeNull();
    expect(await worker.dispatch(request('https://api.typesafe.ai/v1/systemone'))).toBeNull();
    expect(await worker.dispatch(request('https://other.example/', { mode: 'navigate' }))).toBeNull();
  });

  it('passes HTTP errors and redirects through rather than masking them as "offline"', async () => {
    const worker = await installed(async (req) =>
      req.url.includes('/broken') ? new Response('boom', { status: 500 }) : new Response(null, { status: 307 }),
    );

    expect((await worker.dispatch(request('/broken', { mode: 'navigate' })))?.status).toBe(500);
    // A signed-out user's redirect to /login must reach them.
    expect((await worker.dispatch(request('/home', { mode: 'navigate' })))?.status).toBe(307);
  });
});

describe('service worker: what it does do', () => {
  it('caches the offline page on install, bypassing the HTTP cache', async () => {
    const worker = await installed(async () => ok(''));
    const installFetch = worker.fetchSpy.mock.calls.find(([req]) => req.url.endsWith(PWA_OFFLINE_URL));
    expect(installFetch?.[0].cache).toBe('reload');
    expect(worker.self.skipWaiting).toHaveBeenCalled();
  });

  it('serves the offline page when a navigation fails at the network', async () => {
    const worker = await installed(async () => {
      throw new TypeError('Failed to fetch');
    });
    const res = await worker.dispatch(request('/opportunities', { mode: 'navigate' }));
    expect(await res?.text()).toContain('offline page');
  });

  it('uses the navigation preload response when the browser provides one', async () => {
    const worker = await installed(async () => ok('from network'));
    const res = await worker.dispatch(request('/home', { mode: 'navigate' }), ok('from preload'));
    expect(await res?.text()).toBe('from preload');
  });

  it('caches fingerprinted build assets and serves the second request from cache', async () => {
    const worker = await installed(async () => ok('chunk'));
    const asset = request('/_next/static/chunks/app-3f9a1c.js');

    await worker.dispatch(asset);
    const callsAfterFirst = worker.fetchSpy.mock.calls.length;
    const second = await worker.dispatch(asset);

    expect(await second?.text()).toBe('chunk');
    expect(worker.fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not cache a failed asset response', async () => {
    const worker = await installed(async () => new Response('nope', { status: 404 }));
    await worker.dispatch(request('/_next/static/chunks/missing.js'));
    expect(cachedUrls(worker)).not.toContain(`${ORIGIN}/_next/static/chunks/missing.js`);
  });

  it('drops its own old caches on activate and leaves other caches alone', async () => {
    const worker = bootWorker(async () => ok(''));
    worker.caches.store.set('figbolt-static-v0', new Map());
    worker.caches.store.set('someone-elses-cache', new Map());

    await worker.lifecycle('install');
    await worker.lifecycle('activate');

    const names = [...worker.caches.store.keys()];
    expect(names).not.toContain('figbolt-static-v0');
    expect(names).toContain('someone-elses-cache');
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });
});

describe('service worker headers', () => {
  it('is never served from an HTTP cache, so a fix to its rules ships immediately', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const sw = rules.find((rule) => rule.source === '/sw.js');
    const header = (key: string) => sw?.headers.find((h) => h.key === key)?.value;

    expect(header('Cache-Control')).toMatch(/no-store/);
    expect(header('Content-Security-Policy')).toContain("script-src 'self'");
  });
});

describe('web app manifest', () => {
  const m = manifest();

  it('opens standalone at an in-scope start URL', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe(PWA_START_URL);
    expect(m.id).toBe(PWA_START_URL);
    expect(m.start_url!.startsWith(m.scope!)).toBe(true);
  });

  it('declares only icons the icon route will actually render', () => {
    for (const icon of m.icons ?? []) {
      expect(icon.src.startsWith(PWA_ICON_PREFIX)).toBe(true);
      expect(isPwaIconFile(icon.src.slice(PWA_ICON_PREFIX.length))).toBe(true);
    }
  });

  it('has the sizes install prompts require, plus a maskable icon for Android', () => {
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('keeps the maskable glyph inside the 80% safe zone', () => {
    // The glyph is a square; its diagonal must fit the safe-zone circle.
    const maskable = PWA_ICONS['maskable-512.png'];
    expect(maskable.radius).toBe(0);
    expect(maskable.glyph * Math.SQRT2).toBeLessThanOrEqual(0.8);
  });

  it('only offers shortcuts to in-app routes', () => {
    for (const shortcut of m.shortcuts ?? []) {
      expect(shortcut.url.startsWith('/')).toBe(true);
      expect(shortcut.url.startsWith('//')).toBe(false);
    }
  });
});

describe('icon allowlist', () => {
  it('rejects anything that is not a declared icon', () => {
    for (const bad of ['1024.png', '../manifest.ts', '__proto__', 'toString', 'constructor', '192.PNG', '']) {
      expect(isPwaIconFile(bad), bad).toBe(false);
    }
    for (const good of Object.keys(PWA_ICONS)) expect(isPwaIconFile(good)).toBe(true);
  });
});

describe('brand mark', () => {
  it('is the same mark on the offline page as everywhere else', () => {
    // The offline page is static HTML and cannot import the component, so it
    // carries its own copy of the paths. This keeps that copy honest.
    const offline = readFileSync(path.resolve(process.cwd(), 'public/offline.html'), 'utf8');
    expect(offline).toContain(MARK_BODY_PATH);
    expect(offline).toContain(MARK_LEAF_PATH);
  });

  it('has no stray copy of the old bolt-only logo anywhere in the source', () => {
    const OLD = 'M13.5 2.5 6 13.2h4.6L9.8 21.5 18 10.4h-4.9z';
    const files = [
      ...readdirRecursive(path.resolve(process.cwd(), 'src')),
      path.resolve(process.cwd(), 'public/offline.html'),
    ];
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes(OLD));
    expect(offenders).toEqual([]);
  });
});

function readdirRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return readdirRecursive(full);
    return /\.(tsx?|html)$/.test(entry.name) ? [full] : [];
  });
}
