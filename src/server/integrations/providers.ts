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
  | 'meetings'
  | 'notetaker'
  | 'scheduling'
  | 'calling'
  | 'storage'
  | 'crm'
  | 'support'
  | 'product_analytics'
  | 'billing'
  | 'accounting'
  | 'messaging'
  | 'social';

/**
 * How a connector authenticates. This drives what the Connect button does:
 * an `oauth2` provider redirects to a consent screen, an `api_key` provider
 * asks the operator to paste a key, and `none` is a catalogue entry with no
 * connection path yet.
 */
export type ProviderAuth =
  | 'oauth2'
  | 'api_key'
  /** You run the service; Figbolt is pointed at your instance by URL. */
  | 'self_hosted'
  | 'none';

/**
 * How far a connector is actually built. Stated per provider rather than
 * implied, because a list of logos that all look connectable is the most
 * common lie an integrations page tells.
 *
 *   adapter    OAuth (or key) plus a working sync adapter - data really flows
 *   oauth      the connection works; no sync adapter yet, so nothing is pulled
 *   catalogue  declared with correct metadata; demo fixtures only
 */
export type ProviderLevel = 'adapter' | 'oauth' | 'catalogue';

export type ProviderSpec = {
  provider: IntegrationProvider;
  name: string;
  vendor: string;
  kind: ProviderKind;
  description: string;
  /** What Figbolt does with the data once connected. */
  capabilities: string[];
  scopes: string[];
  /** Env vars that must be present for live mode. */
  requiredEnv: string[];
  /** Per-user connection (a mailbox) vs workspace-wide (Slack, Salesforce). */
  perUser: boolean;
  docsUrl: string;
  /** Defaults to 'oauth2'; set explicitly where the provider uses a key. */
  auth?: ProviderAuth;
};

/**
 * Build state per connector, kept in one table rather than scattered across
 * the specs so the honest answer to "what actually works?" is one glance.
 *
 * Anything absent is `catalogue`. Promote an entry here only when the adapter
 * it claims genuinely exists - this map is what the UI shows a buyer.
 */
const LEVELS: Partial<Record<IntegrationProvider, ProviderLevel>> = {
  // OAuth flow implemented in server/integrations/oauth.ts.
  // Real sync adapters live in ./connectors - these two actually pull data.
  gmail: 'adapter',
  google_calendar: 'adapter',
  // Self-hosted Whisper is implemented in server/meetings/transcribe.ts
  // and needs no OAuth - pointing at a URL is the whole connection.
  local_whisper: 'adapter',
  // Every notetaker below pushes through POST /api/v1/notetaker rather than
  // being pulled from. There is no adapter to write per vendor, which is why
  // the free self-hosted ones work exactly as well as the commercial ones.
  granola: 'adapter',
  fathom: 'adapter',
  fireflies: 'adapter',
  otter: 'adapter',
  gong: 'adapter',
  meetily: 'adapter',
  amurex: 'adapter',
  omi: 'adapter',
  pocket: 'adapter',
  plaud: 'adapter',
  vapi: 'adapter',
  google_drive: 'oauth',
  outlook_mail: 'oauth',
  outlook_calendar: 'oauth',
  onedrive: 'oauth',
  ms_teams: 'oauth',
};

export function providerLevel(spec: ProviderSpec): ProviderLevel {
  return LEVELS[spec.provider] ?? 'catalogue';
}

export function providerAuth(spec: ProviderSpec): ProviderAuth {
  return spec.auth ?? 'oauth2';
}

export const PROVIDERS: ProviderSpec[] = [
  {
    provider: 'gmail',
    name: 'Gmail',
    vendor: 'Google',
    kind: 'mail',
    description: 'Sync customer email so Figbolt can resolve threads to accounts and extract commitments.',
    capabilities: [
      'Incremental sync via historyId',
      'Thread preservation with RFC-5322 Message-ID',
      'Contact and account resolution by address and domain',
      'Commitment, objection and product-signal extraction',
    ],
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
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
      'Creates events and sends invitations when scheduling from Figbolt',
    ],
    // `calendar.events` is read *and* write on events, which is what
    // scheduling needs. Read-only cannot create an invite.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
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
    scopes: ['Mail.Read', 'User.Read', 'offline_access'],
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
    // Calendars.ReadWrite is required to create an event; User.Read only
    // supplies the signed-in address for the connection label.
    scopes: ['Calendars.ReadWrite', 'User.Read', 'offline_access'],
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
      'Outreach drafts you send yourself — Figbolt never automates messaging',
    ],
    scopes: ['r_liteprofile', 'r_organization_social'],
    requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://learn.microsoft.com/linkedin',
  },
  /* ── Notetakers ────────────────────────────────────────────────────────
   * The highest-value category for this product: a notetaker produces the
   * transcript, and the transcript is what the memory engine actually reads.
   * Most of these authenticate with a workspace API key rather than OAuth.
   */
  {
    provider: 'granola',
    name: 'Granola',
    vendor: 'Granola',
    kind: 'notetaker',
    description: 'Import Granola meeting notes and transcripts so commitments and objections are extracted automatically.',
    capabilities: [
      'Transcript and enhanced-notes import',
      'Attendee resolution to contacts',
      'Commitment, objection and product-signal extraction',
      'Proposed CRM actions for human approval',
    ],
    scopes: ['notes:read'],
    requiredEnv: ['GRANOLA_API_KEY'],
    perUser: true,
    docsUrl: 'https://www.granola.ai',
    auth: 'api_key',
  },
  {
    provider: 'fathom',
    name: 'Fathom',
    vendor: 'Fathom',
    kind: 'notetaker',
    description: 'Pull Fathom call recordings and transcripts into the customer timeline.',
    capabilities: ['Transcript import', 'Recording links', 'Action-item extraction'],
    scopes: ['recordings:read'],
    requiredEnv: ['FATHOM_API_KEY'],
    perUser: true,
    docsUrl: 'https://fathom.video',
    auth: 'api_key',
  },
  {
    provider: 'fireflies',
    name: 'Fireflies.ai',
    vendor: 'Fireflies',
    kind: 'notetaker',
    description: 'Import Fireflies transcripts and speaker labels for every recorded call.',
    capabilities: ['GraphQL transcript import', 'Speaker diarisation', 'Topic and question extraction'],
    scopes: ['transcript:read'],
    requiredEnv: ['FIREFLIES_API_KEY'],
    perUser: false,
    docsUrl: 'https://docs.fireflies.ai',
    auth: 'api_key',
  },
  {
    provider: 'otter',
    name: 'Otter.ai',
    vendor: 'Otter',
    kind: 'notetaker',
    description: 'Import Otter conversations so meeting notes become structured customer memory.',
    capabilities: ['Conversation import', 'Speaker labels', 'Summary extraction'],
    scopes: ['conversations:read'],
    requiredEnv: ['OTTER_API_KEY'],
    perUser: true,
    docsUrl: 'https://otter.ai',
    auth: 'api_key',
  },
  {
    provider: 'gong',
    name: 'Gong',
    vendor: 'Gong.io',
    kind: 'notetaker',
    description: 'Import Gong call transcripts and trackers alongside your own meeting record.',
    capabilities: ['Call and transcript import', 'Tracker and topic signals', 'Talk-ratio metrics'],
    scopes: ['api:calls:read:transcript', 'api:calls:read:basic'],
    requiredEnv: ['GONG_ACCESS_KEY', 'GONG_ACCESS_SECRET'],
    perUser: false,
    docsUrl: 'https://help.gong.io/docs/receive-data-via-api',
    auth: 'api_key',
  },

  /* ── Meetings ──────────────────────────────────────────────────────────── */
  {
    provider: 'ms_teams',
    name: 'Microsoft Teams',
    vendor: 'Microsoft',
    kind: 'meetings',
    description: 'Sync Teams meetings, recordings and transcripts through Microsoft Graph.',
    capabilities: ['Online meeting sync', 'Recording and transcript retrieval', 'Attendee resolution'],
    scopes: ['OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All', 'offline_access'],
    requiredEnv: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://learn.microsoft.com/graph/api/resources/onlinemeeting',
  },

  /* ── Scheduling ────────────────────────────────────────────────────────── */
  {
    provider: 'calendly',
    name: 'Calendly',
    vendor: 'Calendly',
    kind: 'scheduling',
    description: 'Capture inbound bookings as meetings, with the invitee resolved to a contact.',
    capabilities: ['Scheduled-event sync', 'Invitee questions captured as facts', 'Automatic account linking'],
    scopes: ['default'],
    requiredEnv: ['CALENDLY_OAUTH_CLIENT_ID', 'CALENDLY_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developer.calendly.com',
  },
  {
    provider: 'cal_com',
    name: 'Cal.com',
    vendor: 'Cal.com',
    kind: 'scheduling',
    description: 'Capture Cal.com bookings as meetings on the customer timeline.',
    capabilities: ['Booking sync', 'Attendee resolution', 'Cancellation and reschedule tracking'],
    scopes: ['bookings:read'],
    requiredEnv: ['CAL_COM_API_KEY'],
    perUser: true,
    docsUrl: 'https://cal.com/docs/api-reference',
    auth: 'api_key',
  },

  /* ── Calling ───────────────────────────────────────────────────────────── */
  {
    provider: 'vapi',
    name: 'Vapi voice agent',
    vendor: 'Vapi',
    kind: 'calling',
    description:
      'An AI voice agent that phones contacts for you. Every call is approved by a person, opens by saying it is an AI, and its transcript lands on the contact.',
    capabilities: [
      'Outbound calls, always human-approved',
      'AI disclosure in the first sentence, consent captured per call',
      'Transcript and summary on the contact',
      'Permanent do-not-call on request',
    ],
    scopes: [],
    requiredEnv: ['VAPI_API_KEY', 'VAPI_PHONE_NUMBER_ID'],
    perUser: false,
    docsUrl: 'https://docs.vapi.ai',
    auth: 'api_key',
  },
  {
    provider: 'aircall',
    name: 'Aircall',
    vendor: 'Aircall',
    kind: 'calling',
    description: 'Log calls, durations and recordings against the right contact automatically.',
    capabilities: ['Call log sync', 'Recording and transcript links', 'Contact matching by number'],
    scopes: ['public_api'],
    requiredEnv: ['AIRCALL_API_ID', 'AIRCALL_API_TOKEN'],
    perUser: false,
    docsUrl: 'https://developer.aircall.io',
    auth: 'api_key',
  },
  {
    provider: 'dialpad',
    name: 'Dialpad',
    vendor: 'Dialpad',
    kind: 'calling',
    description: 'Sync Dialpad calls and AI transcripts into the customer record.',
    capabilities: ['Call and transcript sync', 'Contact matching by number', 'Sentiment signals'],
    scopes: ['calls:read', 'recordings:read'],
    requiredEnv: ['DIALPAD_API_KEY'],
    perUser: false,
    docsUrl: 'https://developers.dialpad.com',
    auth: 'api_key',
  },
  {
    provider: 'twilio',
    name: 'Twilio',
    vendor: 'Twilio',
    kind: 'calling',
    description: 'Attach Twilio call and SMS activity to the contact it belongs to.',
    capabilities: ['Call and message log sync', 'Recording retrieval', 'Contact matching by number'],
    scopes: [],
    requiredEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    perUser: false,
    docsUrl: 'https://www.twilio.com/docs/usage/api',
    auth: 'api_key',
  },

  /* ── Documents and storage ─────────────────────────────────────────────── */
  {
    provider: 'google_drive',
    name: 'Google Drive',
    vendor: 'Google',
    kind: 'storage',
    description: 'Index proposals, decks and contracts so answers can cite the document they came from.',
    capabilities: ['Document indexing', 'Change-watch for updated files', 'Citation back to the source file'],
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
    requiredEnv: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developers.google.com/drive',
  },
  {
    provider: 'box',
    name: 'Box',
    vendor: 'Box',
    kind: 'storage',
    description: 'Index Box folders so contracts and proposals are searchable alongside email and meetings.',
    capabilities: ['Folder and file indexing', 'Text extraction', 'Citation back to the source file'],
    scopes: ['root_readonly'],
    requiredEnv: ['BOX_OAUTH_CLIENT_ID', 'BOX_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://developer.box.com/guides/authentication/oauth2',
  },
  {
    provider: 'dropbox',
    name: 'Dropbox',
    vendor: 'Dropbox',
    kind: 'storage',
    description: 'Index Dropbox documents into the knowledge base.',
    capabilities: ['File indexing', 'Text extraction', 'Incremental sync by cursor'],
    scopes: ['files.metadata.read', 'files.content.read'],
    requiredEnv: ['DROPBOX_OAUTH_CLIENT_ID', 'DROPBOX_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://www.dropbox.com/developers/documentation',
  },
  {
    provider: 'onedrive',
    name: 'OneDrive & SharePoint',
    vendor: 'Microsoft',
    kind: 'storage',
    description: 'Index OneDrive and SharePoint documents through Microsoft Graph.',
    capabilities: ['Drive item indexing', 'Delta sync', 'Citation back to the source file'],
    scopes: ['Files.Read.All', 'Sites.Read.All', 'offline_access'],
    requiredEnv: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
    perUser: true,
    docsUrl: 'https://learn.microsoft.com/graph/api/resources/onedrive',
  },
  {
    provider: 'notion',
    name: 'Notion',
    vendor: 'Notion',
    kind: 'storage',
    description: 'Index Notion pages and databases so internal knowledge is answerable.',
    capabilities: ['Page and database indexing', 'Block text extraction', 'Incremental re-index'],
    scopes: [],
    requiredEnv: ['NOTION_OAUTH_CLIENT_ID', 'NOTION_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developers.notion.com',
  },

  /* ── CRM import ────────────────────────────────────────────────────────── */
  {
    provider: 'pipedrive',
    name: 'Pipedrive',
    vendor: 'Pipedrive',
    kind: 'crm',
    description: 'Import organisations, people and deals from Pipedrive, then keep building on top of them.',
    capabilities: ['Organisation, person and deal import', 'Pipeline stage mapping', 'Owner mapping to teammates'],
    scopes: ['deals:read', 'contacts:read'],
    requiredEnv: ['PIPEDRIVE_OAUTH_CLIENT_ID', 'PIPEDRIVE_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developers.pipedrive.com',
  },
  {
    provider: 'attio',
    name: 'Attio',
    vendor: 'Attio',
    kind: 'crm',
    description: 'Import Attio records and lists.',
    capabilities: ['Record and list import', 'Attribute mapping', 'Owner mapping to teammates'],
    scopes: ['record:read', 'object_configuration:read'],
    requiredEnv: ['ATTIO_API_KEY'],
    perUser: false,
    docsUrl: 'https://developers.attio.com',
    auth: 'api_key',
  },
  {
    provider: 'airtable',
    name: 'Airtable',
    vendor: 'Airtable',
    kind: 'crm',
    description: 'Import a pipeline that currently lives in an Airtable base.',
    capabilities: ['Base and table import', 'Field mapping to CRM records', 'One-off migration or recurring sync'],
    scopes: ['data.records:read', 'schema.bases:read'],
    requiredEnv: ['AIRTABLE_OAUTH_CLIENT_ID', 'AIRTABLE_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://airtable.com/developers/web/api/oauth-reference',
  },

  /* ── Support desks ─────────────────────────────────────────────────────── */
  {
    provider: 'front',
    name: 'Front',
    vendor: 'Front',
    kind: 'support',
    description: 'Sync Front conversations so shared-inbox threads become customer memory.',
    capabilities: ['Conversation and comment sync', 'Contact resolution', 'Churn-risk and defect extraction'],
    scopes: ['shared_resources'],
    requiredEnv: ['FRONT_OAUTH_CLIENT_ID', 'FRONT_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://dev.frontapp.com',
  },
  {
    provider: 'help_scout',
    name: 'Help Scout',
    vendor: 'Help Scout',
    kind: 'support',
    description: 'Sync Help Scout conversations into the account timeline.',
    capabilities: ['Conversation sync', 'Customer resolution', 'Satisfaction and defect signals'],
    scopes: [],
    requiredEnv: ['HELPSCOUT_OAUTH_CLIENT_ID', 'HELPSCOUT_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developer.helpscout.com',
  },

  /* ── Product analytics ─────────────────────────────────────────────────── */
  {
    provider: 'mixpanel',
    name: 'Mixpanel',
    vendor: 'Mixpanel',
    kind: 'product_analytics',
    description: 'Read product usage so a quiet account shows up before it churns.',
    capabilities: ['Event and cohort export', 'Account-level usage trends', 'Power-user identification'],
    scopes: [],
    requiredEnv: ['MIXPANEL_SERVICE_ACCOUNT', 'MIXPANEL_SERVICE_SECRET'],
    perUser: false,
    docsUrl: 'https://developer.mixpanel.com',
    auth: 'api_key',
  },
  {
    provider: 'amplitude',
    name: 'Amplitude',
    vendor: 'Amplitude',
    kind: 'product_analytics',
    description: 'Read Amplitude usage data for account health and churn signals.',
    capabilities: ['Event export', 'Account-level usage trends', 'Engagement scoring'],
    scopes: [],
    requiredEnv: ['AMPLITUDE_API_KEY', 'AMPLITUDE_SECRET_KEY'],
    perUser: false,
    docsUrl: 'https://amplitude.com/docs/apis',
    auth: 'api_key',
  },
  {
    provider: 'segment',
    name: 'Segment',
    vendor: 'Twilio Segment',
    kind: 'product_analytics',
    description: 'Receive Segment events as a single stream instead of wiring each analytics tool separately.',
    capabilities: ['Webhook event intake', 'Identity resolution to contacts', 'Account usage rollups'],
    scopes: [],
    requiredEnv: ['SEGMENT_WEBHOOK_SECRET'],
    perUser: false,
    docsUrl: 'https://segment.com/docs/connections/destinations/catalog/webhooks',
    auth: 'api_key',
  },

  /* ── Accounting ────────────────────────────────────────────────────────── */
  {
    provider: 'quickbooks',
    name: 'QuickBooks',
    vendor: 'Intuit',
    kind: 'accounting',
    description: 'See invoices and payment status next to the deal that produced them.',
    capabilities: ['Invoice and payment sync', 'Customer matching to accounts', 'Overdue-payment risk signals'],
    scopes: ['com.intuit.quickbooks.accounting'],
    requiredEnv: ['QUICKBOOKS_OAUTH_CLIENT_ID', 'QUICKBOOKS_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/get-started',
  },
  {
    provider: 'xero',
    name: 'Xero',
    vendor: 'Xero',
    kind: 'accounting',
    description: 'Match Xero invoices and payments to the account and deal they belong to.',
    capabilities: ['Invoice and payment sync', 'Contact matching to accounts', 'Overdue-payment risk signals'],
    scopes: ['accounting.transactions.read', 'accounting.contacts.read', 'offline_access'],
    requiredEnv: ['XERO_OAUTH_CLIENT_ID', 'XERO_OAUTH_CLIENT_SECRET'],
    perUser: false,
    docsUrl: 'https://developer.xero.com/documentation',
  },
  /* ── Free and open source ──────────────────────────────────────────────
   * Transcription billed per minute scales with exactly the behaviour this
   * product is trying to encourage, which is the wrong shape for a small
   * team. Each of these removes that cost: you run them, and the audio never
   * leaves hardware you control.
   */
  {
    provider: 'local_whisper',
    name: 'Local Whisper',
    vendor: 'OpenAI Whisper (self-hosted)',
    kind: 'notetaker',
    description:
      'Transcribe recordings on your own hardware with whisper.cpp, faster-whisper, Speaches or LocalAI. Free, open source, and no audio leaves the machine.',
    capabilities: [
      'Unlimited transcription at no per-minute cost',
      'Audio never leaves hardware you control',
      'Works offline and in demo mode',
      'Any server speaking the Whisper /v1/audio/transcriptions API',
    ],
    scopes: [],
    requiredEnv: ['WHISPER_BASE_URL'],
    perUser: false,
    docsUrl: 'https://github.com/ggml-org/whisper.cpp',
    auth: 'self_hosted',
  },
  {
    provider: 'meetily',
    name: 'Meetily',
    vendor: 'Zackriya Solutions (open source)',
    kind: 'notetaker',
    description:
      'Self-hosted open-source meeting assistant that captures audio locally and produces transcripts and notes.',
    capabilities: [
      'Local capture and transcription',
      'Transcript and summary intake',
      'No per-seat or per-minute vendor cost',
    ],
    scopes: [],
    requiredEnv: ['MEETILY_BASE_URL'],
    perUser: true,
    docsUrl: 'https://github.com/Zackriya-Solutions/meeting-minutes',
    auth: 'self_hosted',
  },
  {
    provider: 'omi',
    name: 'Omi',
    vendor: 'Based Hardware (open source)',
    kind: 'notetaker',
    description:
      'Open-source pendant that records in-person conversations. Point its "conversation created" webhook at Figbolt and each conversation becomes a meeting with a transcript.',
    capabilities: [
      'In-person conversation transcripts',
      'Speaker labels, with the wearer marked as you',
      'Commitment and objection extraction',
      'Proposed CRM actions for human approval',
    ],
    scopes: [],
    // No secret of its own: it posts with a workspace API key. Live once the
    // public address its webhook points at is set.
    requiredEnv: ['APP_URL'],
    perUser: true,
    docsUrl: 'https://docs.omi.me',
    auth: 'api_key',
  },
  {
    provider: 'pocket',
    name: 'Pocket',
    vendor: 'Pocket',
    kind: 'notetaker',
    description:
      'MagSafe AI recorder for in-person conversations and calls. Its signed transcription.completed webhook sends each recording to Figbolt as a meeting with a transcript.',
    capabilities: [
      'In-person and call transcripts with speaker names',
      'Signed webhook deliveries, checked for freshness',
      'Commitment and objection extraction',
      'Proposed CRM actions for human approval',
    ],
    scopes: [],
    // Posts with a workspace API key; live once the public webhook address is set.
    requiredEnv: ['APP_URL'],
    perUser: true,
    docsUrl: 'https://docs.heypocketai.com/docs/api/webhooks',
    auth: 'api_key',
  },
  {
    provider: 'plaud',
    name: 'Plaud',
    vendor: 'Plaud',
    kind: 'notetaker',
    description:
      'Plaud NotePin and Note recorders. Connect through Zapier: the "Transcript & Summary Ready" trigger posts each recording to the Figbolt transcript endpoint.',
    capabilities: ['Transcript import via Zapier', 'Commitment and objection extraction', 'Proposed CRM actions for human approval'],
    scopes: [],
    // No secret of its own: it posts with a workspace API key. Live once the
    // public address its webhook points at is set.
    requiredEnv: ['APP_URL'],
    perUser: true,
    docsUrl: 'https://support.plaud.ai/hc/en-us/articles/12200669941647-Zapier-integration',
    auth: 'api_key',
  },
  {
    provider: 'amurex',
    name: 'Amurex',
    vendor: 'Amurex (open source)',
    kind: 'notetaker',
    description:
      'Open-source meeting copilot that records, transcribes and summarises calls; self-host it and point Figbolt at your instance.',
    capabilities: ['Transcript intake', 'Summary and action-item intake', 'Self-hosted, no vendor lock-in'],
    scopes: [],
    requiredEnv: ['AMUREX_BASE_URL'],
    perUser: true,
    docsUrl: 'https://github.com/thepersonalaicompany/amurex',
    auth: 'self_hosted',
  },
  {
    provider: 'jitsi',
    name: 'Jitsi Meet',
    vendor: 'Jitsi (open source)',
    kind: 'meetings',
    description:
      'Open-source video meetings you can self-host. Recordings are handed to transcription like any other source.',
    capabilities: [
      'Self-hosted video meetings',
      'Recording intake for transcription',
      'No per-host licence',
    ],
    scopes: [],
    requiredEnv: ['JITSI_BASE_URL'],
    perUser: false,
    docsUrl: 'https://jitsi.github.io/handbook/',
    auth: 'self_hosted',
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
