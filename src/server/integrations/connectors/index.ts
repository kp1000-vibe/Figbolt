import type { IntegrationProvider } from '@/db/schema';
import type { Ctx } from '../../context';
import { freshAccessToken } from '../oauth';
import type { CalendarConnector, MailConnector } from '../providers';
import { GmailConnector } from './gmail';
import { GoogleCalendarConnector } from './google-calendar';

/**
 * Connector registry.
 *
 * One place that answers "can this provider actually sync, and with what?".
 * Anything absent here is catalogue-only: the integration row exists, the
 * OAuth grant may even work, but no data flows. `runSync` consults this and
 * says so plainly rather than reporting a successful sync of nothing — which
 * is what it used to do.
 *
 * Adding a connector is deliberately a two-step act: implement the interface,
 * then register it here and promote its level in providers.ts. Both are
 * visible in a diff, so the integrations page cannot drift into claiming more
 * than the code does.
 */

export type ResolvedConnector =
  | { kind: 'mail'; connector: MailConnector }
  | { kind: 'calendar'; connector: CalendarConnector };

/** Providers with a working sync adapter, for the UI and for tests. */
export const SYNCABLE: readonly IntegrationProvider[] = ['gmail', 'google_calendar'];

export function hasConnector(provider: IntegrationProvider): boolean {
  return SYNCABLE.includes(provider);
}

/**
 * Build a live connector for this workspace's connection, or null when there
 * is no adapter, no grant, or no usable token.
 *
 * The token is resolved through `freshAccessToken`, so an expired grant is
 * refreshed here rather than failing mid-sync.
 */
export async function resolveConnector(
  ctx: Ctx,
  provider: IntegrationProvider,
  accountLabel: string | null,
): Promise<ResolvedConnector | null> {
  if (!hasConnector(provider)) return null;

  const accessToken = await freshAccessToken(ctx, provider);
  if (!accessToken) return null;

  switch (provider) {
    case 'gmail':
      return {
        kind: 'mail',
        // The connected address decides inbound vs outbound. Without it every
        // message would look inbound and the direction data would be useless.
        connector: new GmailConnector(accessToken, accountLabel ?? ''),
      };
    case 'google_calendar':
      return { kind: 'calendar', connector: new GoogleCalendarConnector(accessToken) };
    default:
      return null;
  }
}

export { GmailConnector, GoogleCalendarConnector };
