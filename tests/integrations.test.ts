import { describe, expect, it } from 'vitest';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@/db/schema';
import {
  PROVIDERS,
  providerAuth,
  providerLevel,
  findProvider,
} from '@/server/integrations/providers';
import { SYNCABLE, hasConnector } from '@/server/integrations/connectors';

/**
 * The integration catalogue, and the one thing it must not do.
 *
 * A list of forty logos that all look connectable is the most common lie an
 * integrations page tells. Every provider here declares how far it is actually
 * built — `adapter`, `oauth` or `catalogue` — and these tests make that
 * declaration binding: a connector cannot claim to sync unless a connector
 * object exists, and cannot claim OAuth unless an OAuth spec exists.
 *
 * They are deliberately structural rather than behavioural. Proving Gmail
 * really syncs needs a Google account; proving the page cannot overstate what
 * Gmail does needs only this.
 */

describe('the catalogue is internally consistent', () => {
  it('has a spec for every declared provider, and no orphans', () => {
    const declared = [...INTEGRATION_PROVIDERS].sort();
    const specced = PROVIDERS.map((p) => p.provider).sort();
    expect(specced).toEqual(declared);
  });

  it('declares no provider twice', () => {
    const seen = PROVIDERS.map((p) => p.provider);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('gives every provider the metadata the UI renders', () => {
    for (const spec of PROVIDERS) {
      expect(spec.name, spec.provider).toBeTruthy();
      expect(spec.vendor, spec.provider).toBeTruthy();
      expect(spec.kind, spec.provider).toBeTruthy();
      expect(spec.description.length, spec.provider).toBeGreaterThan(20);
      expect(spec.capabilities.length, spec.provider).toBeGreaterThan(0);
      expect(spec.docsUrl.startsWith('https://'), spec.provider).toBe(true);
      // Without this, "live mode" cannot tell configured from unconfigured.
      expect(spec.requiredEnv.length, spec.provider).toBeGreaterThan(0);
    }
  });

  it('covers the categories a small sales team actually uses', () => {
    const kinds = new Set(PROVIDERS.map((p) => p.kind));
    for (const kind of ['mail', 'calendar', 'notetaker', 'storage', 'crm', 'calling']) {
      expect(kinds.has(kind as never), `missing category: ${kind}`).toBe(true);
    }
  });
});

describe('a connector cannot claim more than it does', () => {
  it('only marks a provider "adapter" when a real connector exists', async () => {
    const claiming = PROVIDERS.filter((p) => providerLevel(p) === 'adapter').map((p) => p.provider);

    // This is the load-bearing assertion. Promoting a provider in the level
    // table without writing its connector would ship a page that says "Syncs"
    // next to something that pulls nothing.
    for (const provider of claiming) {
      expect(hasConnector(provider), `${provider} claims to sync`).toBe(true);
    }
    expect([...claiming].sort()).toEqual([...SYNCABLE].sort());
  });

  it('only marks a provider "oauth" when an OAuth spec exists for it', async () => {
    // supportsOAuth reads the credentials too, so the check is on the map
    // itself: a provider claiming `oauth` must appear in oauth.ts.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/integrations/oauth.ts', 'utf8'),
    );
    const map = source.slice(
      source.indexOf('const OAUTH:'),
      source.indexOf('export function supportsOAuth'),
    );

    for (const spec of PROVIDERS) {
      const level = providerLevel(spec);
      if (level === 'oauth' || level === 'adapter') {
        expect(map.includes(`${spec.provider}:`), `${spec.provider} claims OAuth`).toBe(true);
      }
    }
  });

  it('defaults an unlisted provider to catalogue, never to something better', () => {
    // The safe direction: a new provider understates until promoted.
    const unlisted = PROVIDERS.filter(
      (p) => !['gmail', 'google_calendar', 'google_drive', 'outlook_mail', 'outlook_calendar', 'onedrive', 'ms_teams'].includes(p.provider),
    );
    expect(unlisted.length).toBeGreaterThan(25);
    for (const spec of unlisted) {
      expect(providerLevel(spec), spec.provider).toBe('catalogue');
    }
  });

  it('does not offer an OAuth redirect for an API-key connector', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/integrations/oauth.ts', 'utf8'),
    );
    const map = source.slice(
      source.indexOf('const OAUTH:'),
      source.indexOf('export function supportsOAuth'),
    );

    for (const spec of PROVIDERS) {
      if (providerAuth(spec) === 'api_key') {
        expect(map.includes(`${spec.provider}:`), `${spec.provider} is key-based`).toBe(false);
      }
    }
  });
});

describe('notetakers are modelled as transcript sources', () => {
  it('declares the ones a small team is likely to already use', () => {
    const notetakers = PROVIDERS.filter((p) => p.kind === 'notetaker').map((p) => p.provider);
    for (const expected of ['granola', 'fathom', 'fireflies', 'otter']) {
      expect(notetakers).toContain(expected as IntegrationProvider);
    }
  });

  it('describes each one in terms of transcripts, not generic sync', () => {
    // The whole value of this category is that it feeds the memory engine.
    for (const spec of PROVIDERS.filter((p) => p.kind === 'notetaker')) {
      const text = `${spec.description} ${spec.capabilities.join(' ')}`.toLowerCase();
      expect(
        text.includes('transcript') || text.includes('notes'),
        `${spec.provider} should describe transcript intake`,
      ).toBe(true);
    }
  });

  it('marks them key-based rather than inventing an OAuth app', () => {
    // None of these publish a general OAuth app platform; claiming otherwise
    // would send an operator hunting for a client id that does not exist.
    for (const provider of ['granola', 'fathom', 'fireflies', 'otter']) {
      const spec = findProvider(provider as IntegrationProvider);
      expect(spec, provider).toBeDefined();
      expect(providerAuth(spec!), provider).toBe('api_key');
    }
  });
});

describe('sync reports what happened', () => {
  it('says plainly when a connected provider has no adapter', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/integrations/manage.ts', 'utf8'),
    );

    // It used to record a successful sync of zero records, which reads as
    // "nothing to do" rather than "this does not work yet".
    expect(source).toContain('no sync adapter is implemented yet');
    expect(source).toContain('hasConnector');
  });

  it('persists the cursor after every page, so a run can resume', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/integrations/manage.ts', 'utf8'),
    );
    expect(source).toContain('MAX_PAGES_PER_RUN');
    expect(source).toContain('syncCursor: cursor');
  });
});
