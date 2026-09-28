import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { absoluteUrl, PRIVATE_PREFIXES, PUBLIC_ROUTES, productJsonLd, SITE } from '@/lib/seo';
import { metadata as rootMetadata } from '@/app/layout';
import { metadata as landingMetadata } from '@/app/page';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';

/**
 * SEO, and the one way it could do real damage.
 *
 * Getting indexed is a nice-to-have. *Not* getting indexed is a requirement:
 * almost every route in this app is a workspace's customer data behind a
 * session, so the default must be noindex and only the marketing page may opt
 * out of it. These tests exist so that adding a page cannot quietly publish
 * account URLs to a search engine.
 */

const APP = path.resolve(process.cwd(), 'src/app');

describe('nothing is indexable by accident', () => {
  it('defaults every route to noindex at the root', () => {
    expect(rootMetadata.robots).toMatchObject({ index: false, follow: false });
  });

  it('opts exactly one page into indexing', () => {
    // Every page.tsx under src/app, checked for an explicit index: true.
    const pages = globSync('**/page.tsx', { cwd: APP }).sort();
    expect(pages.length).toBeGreaterThan(10);

    const indexable = pages.filter((rel) => {
      const source = readFileSync(path.join(APP, rel), 'utf8');
      return /index:\s*true/.test(source);
    });

    // If this fails, a route holding customer data just became crawlable.
    expect(indexable).toEqual(['page.tsx']);
  });

  it('indexes the landing page with a canonical URL', () => {
    expect(landingMetadata.robots).toMatchObject({ index: true, follow: true });
    expect(landingMetadata.alternates?.canonical).toBe('/');
  });

  it('keeps the app out of robots.txt', () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0]! : rules;
    const disallow = ([] as string[]).concat(rule.disallow ?? []);

    for (const prefix of ['/api/', '/accounts', '/ask', '/settings', '/inbox']) {
      expect(disallow, `${prefix} must be disallowed`).toContain(prefix);
    }
    expect(rule.allow).toBe('/');
  });

  it('disallows every route that is not public', () => {
    // Self-maintaining: add a page under src/app and this fails until the
    // route is either declared public or covered by a private prefix. The
    // hand-kept list already missed /automations, /integrations, /meetings,
    // /product-signals and /learning once.
    const segments = new Set<string>();
    for (const rel of globSync('**/page.tsx', { cwd: APP })) {
      if (rel === 'page.tsx') continue; // the landing page
      // Normalise the separator without regex escaping: path.sep on
      // Windows, '/' elsewhere.
      const parts = rel
        .split(path.sep)
        .flatMap((part) => part.split('/'))
        .filter((part) => part && !part.startsWith('(') && part !== 'page.tsx');
      if (parts[0]) segments.add(`/${parts[0]}`);
    }
    // Guard against the check passing because it found nothing to check:
    // globSync returns backslash-separated paths on Windows.
    expect(segments.size, 'no route segments were discovered').toBeGreaterThan(10);

    const uncovered = [...segments].filter(
      (segment) =>
        !PUBLIC_ROUTES.includes(segment as (typeof PUBLIC_ROUTES)[number]) &&
        !PRIVATE_PREFIXES.some((prefix) => segment.startsWith(prefix.replace(/\/$/, ''))),
    );

    expect(uncovered.sort(), 'routes neither public nor disallowed').toEqual([]);
  });

  it('lists only public routes in the sitemap', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(PUBLIC_ROUTES.map((r) => absoluteUrl(r)));

    // Belt and braces: no sitemap entry may match a private prefix.
    for (const url of urls) {
      const pathname = new URL(url).pathname;
      const leaked = PRIVATE_PREFIXES.filter((p) => pathname.startsWith(p));
      expect(leaked, `${url} is private`).toEqual([]);
    }
  });
});

describe('the canonical origin', () => {
  it('is never localhost', () => {
    // A canonical tag or sitemap pointing at localhost is worse than none.
    expect(SITE.url).not.toContain('localhost');
    expect(SITE.url).not.toContain('127.0.0.1');
    expect(SITE.url.startsWith('https://')).toBe(true);
    expect(SITE.url.endsWith('/')).toBe(false);
  });

  it('builds absolute URLs without doubling slashes', () => {
    expect(absoluteUrl('/')).toBe(`${SITE.url}/`);
    expect(absoluteUrl('sitemap.xml')).toBe(`${SITE.url}/sitemap.xml`);
  });
});

describe('what a crawler is told', () => {
  it('keeps the description inside what a search result will show', () => {
    expect(SITE.description.length).toBeGreaterThan(80);
    expect(SITE.description.length).toBeLessThanOrEqual(170);
  });

  it('names the product and the assistant distinctly', () => {
    // Figbolt is the product; Bolt is the AI inside it. The description should
    // introduce both, because both are things people will search for.
    expect(SITE.name).toBe('Figbolt');
    expect(SITE.assistant).toBe('Bolt');
    expect(SITE.description).toContain('Figbolt');
    expect(SITE.description).toContain('Bolt');
  });

  it('emits structured data that parses and is internally consistent', () => {
    const json = JSON.parse(JSON.stringify(productJsonLd()));
    expect(json['@context']).toBe('https://schema.org');

    const types = json['@graph'].map((n: { '@type': string }) => n['@type']);
    expect(types).toContain('Organization');
    expect(types).toContain('SoftwareApplication');

    // Every @id reference must resolve to a node in the same graph.
    const ids = new Set(json['@graph'].map((n: { '@id': string }) => n['@id']));
    for (const match of JSON.stringify(json).matchAll(/"@id":"([^"]+)"/g)) {
      const id = match[1]!;
      expect(ids.has(id), `${id} is referenced but not defined`).toBe(true);
    }
  });
});
