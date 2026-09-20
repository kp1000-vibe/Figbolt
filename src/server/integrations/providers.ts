import { env } from '@/lib/env';
import type { IntegrationProvider } from '@/db/schema';

/**
 * Integration provider interfaces.
 *
 * Every connector is defined behind an interface with two implementations: a
 * real OAuth-backed adapter and a demo adapter. The demo adapter is not a
 * placeholder that throws — it returns realistic fixture data through the same
 * interface, so the ingestion pipeline, sync-job bookkeeping and error handling
 * are all exercised without credentials.
 *
 * That means "connect Gmail for real" is a configuration change plus one
 * adapter, not a re-architecture.
 */

export type ProviderKind =
  | 'mail'
  | 'calendar'
  | 'messaging'
  | 'meetings'
  | 'crm'
  | 'product_analytics'
  | 'support'
  | 'billing'
  | 'social';

export type ProviderSpec = {
  provider: IntegrationProvider;
  name: string;
  vendor: string;
  kind: ProviderKind;
  description: string;
  /** What Nexus does with the data once connected. */
  capabilities: string[];
  scopes: string[];
  /** Env vars that must be present for live mode. */
  requiredEnv: string[];
  /** Per-user connection (a mailbox) vs workspace-wide (Slack, Salesforce). */
  perUser: boolean;
  docsUrl: string;
};

export const PROVIDERS: ProviderSpec[] = [
  {
    provider: 'gmail',
    name: 'Gmail',
    vendor: 'Google',
    kind: 'mail',
    description: 'Sync customer email so Nexus can resolve threads to accounts and extract commitments.',
    capabilities: [
      'Incremental sync via historyId',
      'Thread preservation with RFC-5322 Message-ID',
      'Contact and account resolution by address and domain',
      'Commitment, objection and product-signal extraction',
    ],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    requiredEnv: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developers.google.com/gmail/api',
  },
  {
    provider: 'google_calendar',
    name: 'Google Calendar',
    vendor: 'Google',
    kind: 'calendar',
    description: 'Sync meetings and attendees, and link them to the right account and deal.',
    capabilities: [
      'Incremental sync via syncToken',
      'Attendee resolution to contacts',
      'Automatic account and opportunity linking',
    ],
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    requiredEnv: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developers.google.com/calendar',
  },
  {
    provider: 'outlook_mail',
    name: 'Outlook Mail',
    vendor: 'Microsoft',
    kind: 'mail',
    description: 'Sync customer email from Microsoft 365 mailboxes.',
    capabilities: ['Delta query sync', 'Thread preservation', 'Extraction pipeline'],
    scopes: ['Mail.Read', 'offline_access'],
    requiredEnv: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://learn.microsoft.com/graph/api/resources/mail-api-overview',
  },
  {
    provider: 'outlook_calendar',
    name: 'Outlook Calendar',
    vendor: 'Microsoft',
    kind: 'calendar',
    description: 'Sync meetings and attendees from Microsoft 365 calendars.',
    capabilities: ['Delta query sync', 'Attendee resolution'],
    scopes: ['Calendars.Read', 'offline_access'],
    requiredEnv: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://learn.microsoft.com/graph/api/resources/calendar',
  },
  {
    provider: 'slack',
    name: 'Slack',
    vendor: 'Slack',
    kind: 'messaging',
    description: 'Send notifications and approval requests where the team already works.',
    capabilities: [
      'Deal-risk and approval notifications',
      'Inline approve/reject on high-risk actions',
      'Signed webhook verification',
    ],
    scopes: ['chat:write', 'channels:read', 'users:read'],
    requiredEnv: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'],
    perUser: false,
    docsUrl: 'https://api.slack.com',
  },
  {
    provider: 'zoom',
    name: 'Zoom',
    vendor: 'Zoom',
    kind: 'meetings',
    description: 'Pull meeting recordings and transcripts for meeting intelligence.',
    capabilities: ['Recording and transcript retrieval', 'Speaker attribution', 'Webhook on recording ready'],
    scopes: ['recording:read', 'meeting:read'],
    requiredEnv: ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developers.zoom.us',
  },
  {
    provider: 'google_meet',
    name: 'Google Meet',
    vendor: 'Google',
    kind: 'meetings',
    description: 'Pull Meet recordings and captions where the workspace records them.',
    capabilities: ['Recording and caption retrieval', 'Participant attribution'],
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    requiredEnv: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developers.google.com/meet',
  },
  {
    provider: 'hubspot',
    name: 'HubSpot',
    vendor: 'HubSpot',
    kind: 'crm',
    description: 'Import existing companies, contacts and deals, then keep them in sync.',
    capabilities: ['Initial import', 'Incremental sync', 'Field mapping', 'Conflict resolution'],
    scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read'],
    requiredEnv: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developers.hubspot.com',
  },
  {
    provider: 'salesforce',
    name: 'Salesforce',
    vendor: 'Salesforce',
    kind: 'crm',
    description: 'Import accounts, contacts and opportunities from an existing Salesforce org.',
    capabilities: ['Initial import', 'Incremental sync via SystemModstamp', 'Custom field mapping'],
    scopes: ['api', 'refresh_token'],
    requiredEnv: ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developer.salesforce.com',
  },
  {
    provider: 'posthog',
    name: 'PostHog',
    vendor: 'PostHog',
    kind: 'product_analytics',
    description:
      'Pull daily product-usage rollups so the CRM can see whether a customer is actually using what they bought.',
    capabilities: [
      'Daily active users, sessions and key actions per account',
      'Per-person activity for power-user identification',
      'Usage trend feeds account health and the churn detector',
      'Expansion signals from usage growth against current ARR',
    ],
    scopes: ['project:read', 'insight:read'],
    requiredEnv: ['POSTHOG_API_KEY', 'POSTHOG_PROJECT_ID'],
    perUser: false,
    docsUrl: 'https://posthog.com/docs/api',
  },
  {
    provider: 'zendesk',
    name: 'Zendesk',
    vendor: 'Zendesk',
    kind: 'support',
    description:
      'Ingest support tickets as first-class customer interactions, not as a separate silo.',
    capabilities: [
      'Ticket text, status, priority and satisfaction',
      'Bug and feature-request extraction into product signals',
      'Churn language recorded as a high-severity concern',
      'Idempotent on the provider ticket id, so retries update rather than duplicate',
    ],
    scopes: ['tickets:read', 'users:read'],
    requiredEnv: ['ZENDESK_SUBDOMAIN', 'ZENDESK_API_TOKEN', 'ZENDESK_EMAIL'],
    perUser: false,
    docsUrl: 'https://developer.zendesk.com/api-reference',
  },
  {
    provider: 'intercom',
    name: 'Intercom',
    vendor: 'Intercom',
    kind: 'support',
    description: 'Ingest conversations and tickets from Intercom through the same pipeline as Zendesk.',
    capabilities: ['Conversation and ticket ingestion', 'Product-signal extraction', 'Churn-risk detection'],
    scopes: ['read_conversations', 'read_users'],
    requiredEnv: ['INTERCOM_ACCESS_TOKEN'],
    perUser: false,
    docsUrl: 'https://developers.intercom.com',
  },
  {
    provider: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    kind: 'billing',
    description: 'Keep contract value, seat counts and payment health current without anyone retyping them.',
    capabilities: [
      'Subscription value and seat count as tracked facts',
      'Renewal dates on the account timeline',
      'Failed-payment and downgrade events as risk signals',
    ],
    scopes: ['read_only'],
    requiredEnv: ['STRIPE_SECRET_KEY'],
    perUser: false,
    docsUrl: 'https://stripe.com/docs/api',
  },
  {
    provider: 'linkedin',
    name: 'LinkedIn',
    vendor: 'LinkedIn',
    kind: 'social',
    description:
      "Read-only enrichment of titles and moves for known contacts, under LinkedIn's own API terms.",
    capabilities: [
      'Title and employer changes on existing contacts',
      'Job-change alerts on champions who move',
      'Outreach drafts you send yourself — Nexus never automates messaging',
    ],
    scopes: ['r_liteprofile', 'r_organization_social'],
    requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://learn.microsoft.com/linkedin',
  },
];

export function findProvider(provider: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.provider === provider);
}

/** Whether live mode is actually configured for a provider. */
export function isLiveConfigured(spec: ProviderSpec): boolean {
  if (env.INTEGRATION_MODE !== 'live') return false;
  return spec.requiredEnv.every((key) => Boolean(process.env[key]));
}

export type ConnectorStatus = 'available_live' | 'demo_only' | 'missing_credentials';

export function connectorStatus(spec: ProviderSpec): ConnectorStatus {
  if (env.INTEGRATION_MODE !== 'live') return 'demo_only';
  return isLiveConfigured(spec) ? 'available_live' : 'missing_credentials';
}

/* ── Sync contract ────────────────────────────────────────────────────────── */

export type SyncCursor = string | null;

export type SyncedEmail = {
  externalId: string;
  messageId: string | null;
  inReplyTo: string | null;
  threadExternalId: string | null;
  direction: 'inbound' | 'outbound';
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  bodyText: string;
  sentAt: Date;
  hasAttachments: boolean;
};

export type SyncedMeeting = {
  externalId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  meetingUrl: string | null;
  recordingUrl: string | null;
  participantEmails: string[];
  organizerEmail: string | null;
  transcript: { speaker: string; text: string; startSeconds: number; isCustomer: boolean }[] | null;
};

export type SyncResult<T> = {
  items: T[];
  nextCursor: SyncCursor;
  /** True when the provider has more pages ready now. */
  hasMore: boolean;
};

/**
 * What every mail connector must implement. `pull` is cursor-based so an
 * incremental sync is the same code path as an initial backfill — only the
 * starting cursor differs.
 */
export interface MailConnector {
  readonly provider: IntegrationProvider;
  readonly mode: 'live' | 'demo';
  pull(cursor: SyncCursor, limit: number): Promise<SyncResult<SyncedEmail>>;
}

export interface CalendarConnector {
  readonly provider: IntegrationProvider;
  readonly mode: 'live' | 'demo';
  pull(cursor: SyncCursor, limit: number): Promise<SyncResult<SyncedMeeting>>;
}

export class IntegrationNotConfiguredError extends Error {
  readonly code = 'INTEGRATION_NOT_CONFIGURED';
  constructor(provider: string, missing: string[]) {
    super(
      `${provider} is not configured for live mode. Set ${missing.join(', ')} and INTEGRATION_MODE=live.`,
    );
    this.name = 'IntegrationNotConfiguredError';
  }
}
