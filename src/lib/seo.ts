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
  /** What it is, in one line. Leads every title and the link-preview card. */
  category: 'The AI-native CRM for small businesses',
  /** Canonical origin. Overridable so preview deploys do not claim figbolt.com. */
  url: canonicalOrigin(),
  /** Under ~160 characters, so search results do not truncate mid-sentence. */
  description:
    'Figbolt is the AI-native CRM for small businesses and solopreneurs. It fills itself in from email and meetings, and Bolt answers with evidence.',
  /** Longer form, for OG cards and structured data where there is room. */
  longDescription:
    'Figbolt is an AI-native CRM for small businesses and solopreneurs — from one person to a team of ten — built so nobody has to maintain it. It derives accounts, deals and follow-ups from the email, meetings, tickets and product usage you already have, so there is no data entry. Bolt, the built-in AI analyst, answers questions with citations back to the records it used, and every action that changes data or reaches a customer waits for a human.',
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
export const PUBLIC_ROUTES = [
  '/',
  '/ai-crm',
  '/crm-for-small-business',
  '/crm-for-solopreneurs',
  '/why',
] as const;

/**
 * When each public page's content last changed, for the sitemap's lastmod.
 * A real date rather than the build time: a sitemap that claims every page
 * changed at each deploy teaches crawlers to ignore the field.
 */
export const CONTENT_UPDATED: Record<(typeof PUBLIC_ROUTES)[number], string> = {
  '/': '2026-10-04',
  '/ai-crm': '2026-10-04',
  '/crm-for-small-business': '2026-10-04',
  '/crm-for-solopreneurs': '2026-10-04',
  '/why': '2026-10-04',
};

/** JSON-LD for a <script> tag, with `<` escaped so content cannot end the tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * Route prefixes that hold customer data or a session, and must never be
 * crawled. Kept here rather than inline in robots.ts so the list is reviewable
 * in one place next to the reason it exists.
 */
export const PRIVATE_PREFIXES = [
  '/admin',
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
      faqPageLd(HOME_FAQS, absoluteUrl('/#faq')),
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
          'AI voice agents that make follow-up calls, each approved by a person',
          'Transcripts from pocket AI recorders such as Pocket, Plaud and Omi',
          'AI-native CRM for small businesses and solopreneurs',
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

/**
 * The homepage FAQ. Rendered visibly on the page and mirrored in FAQPage
 * structured data — search engines only honour FAQ markup for questions the
 * page actually shows, so both read from this one list.
 */
export const HOME_FAQS: { q: string; a: string }[] = [
  {
    q: 'What is Figbolt?',
    a: 'Figbolt is an AI-native CRM for small businesses and solopreneurs. It builds your customer records from your email and meetings, so there is no data entry, and Bolt, its AI assistant, answers questions about your customers with links to the evidence.',
  },
  {
    q: 'What makes a CRM AI-native?',
    a: 'An AI-native CRM is built around AI from the first record: it fills itself in from your conversations instead of asking you to type, and AI is how it works rather than an add-on.',
  },
  {
    q: 'Who is Figbolt for?',
    a: 'Small businesses, solopreneurs, freelancers and consultants — teams of one to ten who have customers to look after and no one whose job is keeping a CRM up to date.',
  },
  {
    q: 'Does Figbolt contact customers on its own?',
    a: 'No. Figbolt can draft emails and suggest changes, but anything that reaches a customer or changes a deal waits for your approval.',
  },
  {
    q: 'Can Figbolt make calls to customers?',
    a: 'Yes. AI voice agents can make follow-up calls for you. Every call is approved by a person first, the agent says it is an AI in its first sentence, it cannot agree to prices or terms, and anyone who asks not to be called again never is. The transcript lands on the contact.',
  },
  {
    q: 'Does Figbolt work with pocket AI recorders?',
    a: 'Yes. Pocket and Omi send each recorded conversation straight to Figbolt, and Plaud connects through Zapier. In-person conversations become meeting notes with follow-ups, like any call.',
  },
  {
    q: 'How do I start?',
    a: 'Create a workspace and connect Gmail and Google Calendar, or explore the demo workspace first. No credit card is needed to start.',
  },
];

type Faq = { q: string; a: string };

function faqPageLd(faqs: Faq[], id: string) {
  return {
    '@type': 'FAQPage',
    '@id': id,
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

/** Structured data for a guide page: the page, its breadcrumb, and its FAQ. */
export function guideJsonLd(guide: {
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  h1: string;
  faqs: Faq[];
  updated: string;
}) {
  const url = absoluteUrl(guide.path);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: guide.h1,
        description: guide.description,
        inLanguage: 'en',
        dateModified: guide.updated,
        isPartOf: { '@id': absoluteUrl('/#website') },
        about: { '@id': absoluteUrl('/#software') },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE.name, item: SITE.url },
          { '@type': 'ListItem', position: 2, name: guide.eyebrow, item: url },
        ],
      },
      faqPageLd(guide.faqs, `${url}#faq`),
    ],
  };
}
