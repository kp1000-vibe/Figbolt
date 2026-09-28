import { publicOrigin } from '@/lib/app-url';

/**
 * One source of truth for everything a crawler or a link preview reads.
 *
 * The root layout, the landing page, robots.txt, the sitemap and the generated
 * OG image all read from here, so the name in a tweet card cannot drift from
 * the name in the <title>.
 *
 * The indexing rule is the important part, and it is the opposite of a normal
 * marketing site: **the default is noindex**. Figbolt is a CRM, so nearly every
 * route holds someone's customer data — account pages, deal pages, the Ask Bolt
 * transcript, the approval queue. A route becomes indexable only by saying so
 * explicitly, which today means the landing page and nothing else. Getting this
 * backwards would leak workspace URLs into search results.
 */

export const SITE = {
  name: 'Figbolt',
  /** The AI assistant inside the product. Figbolt is the product; Bolt answers. */
  assistant: 'Bolt',
  tagline: 'Sweet deals, lightning fast',
  /** Canonical origin. Overridable so preview deploys do not claim figbolt.com. */
  url: canonicalOrigin(),
  /** Under ~160 characters, so search results do not truncate mid-sentence. */
  description:
    'The CRM nobody has to fill in. Figbolt builds the record from your email, meetings and tickets — and Bolt, its AI analyst, answers with the evidence.',
  /** Longer form, for OG cards and structured data where there is room. */
  longDescription:
    'Figbolt is an agent-native CRM. It derives accounts, deals and commitments from the email, meetings, tickets and product usage you already have, so reps stop doing data entry. Bolt, the built-in AI analyst, answers questions with citations back to the records it used, and every action that changes data or reaches a customer waits for a human.',
  locale: 'en_US',
  twitter: '@figbolt',
} as const;

function canonicalOrigin(): string {
  // publicOrigin, not appOrigin: a canonical tag or sitemap entry is read by
  // crawlers and other people, so localhost is wrong even in development.
  return publicOrigin();
}

export function absoluteUrl(path = '/'): string {
  return `${SITE.url}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Routes a crawler may index. Everything else inherits the root layout's
 * `robots: { index: false }`, and robots.txt disallows the app outright.
 */
export const PUBLIC_ROUTES = ['/', '/why'] as const;

/**
 * Route prefixes that hold customer data or a session, and must never be
 * crawled. Kept here rather than inline in robots.ts so the list is reviewable
 * in one place next to the reason it exists.
 */
export const PRIVATE_PREFIXES = [
  '/api/',
  '/accounts',
  '/agents',
  '/analytics',
  '/ask',
  '/automations',
  '/contacts',
  '/home',
  '/inbox',
  '/integrations',
  '/knowledge',
  '/learning',
  '/login',
  '/meetings',
  '/onboarding',
  '/opportunities',
  '/product-signals',
  '/prospecting',
  '/settings',
  '/signup',
  '/tasks',
] as const;

/**
 * Schema.org description of the product, for search result rich cards.
 *
 * Only claims that the landing page itself makes. A structured-data block that
 * promises features the page does not describe is how a site earns a manual
 * action, quite apart from being untrue.
 */
export function productJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': absoluteUrl('/#organization'),
        name: SITE.name,
        url: SITE.url,
        description: SITE.description,
      },
      {
        '@type': 'WebSite',
        '@id': absoluteUrl('/#website'),
        url: SITE.url,
        name: SITE.name,
        description: SITE.description,
        publisher: { '@id': absoluteUrl('/#organization') },
        inLanguage: 'en',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': absoluteUrl('/#software'),
        name: SITE.name,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'CRM',
        operatingSystem: 'Web',
        url: SITE.url,
        description: SITE.longDescription,
        publisher: { '@id': absoluteUrl('/#organization') },
        featureList: [
          'Derives CRM records from email, meetings, tickets and product usage',
          'Answers questions with citations back to the source records',
          'AI agents that act through typed, permission-checked tools',
          'Human approval required for anything consequential',
          'MCP server and REST API for external agents',
        ],
      },
    ],
  };
}
