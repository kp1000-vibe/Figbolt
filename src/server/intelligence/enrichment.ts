import { env } from '@/lib/env';

/**
 * Prospect enrichment providers.
 *
 * One interface, several adapters. The fixture adapter is not a stub that
 * throws — it returns a realistic candidate set so the whole prospecting flow
 * (ICP derivation, scoring, drafting, review) is exercised without a data
 * vendor. Connecting Apollo, Clay, People Data Labs or a Clearbit-style
 * provider means implementing `findSimilar` and nothing else.
 *
 * Note on scraping: these adapters call vendor APIs under their terms. Figbolt
 * does not scrape sites whose terms prohibit it, and there is deliberately no
 * generic "fetch a page and parse it" adapter here.
 */

export type ProspectContact = {
  firstName: string;
  lastName: string;
  title: string;
  seniority: 'c_level' | 'vp' | 'director' | 'manager' | 'ic';
  email: string | null;
  linkedinUrl: string | null;
};

export type ProspectCandidate = {
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  country: string | null;
  location: string | null;
  description: string;
  technologies: string[];
  /** Hiring, funding or expansion evidence. */
  growthSignal: string | null;
  /** Evidence they are actively looking for something like this. */
  intentSignal: string | null;
  /** An existing relationship that could open the door. */
  warmPath: string | null;
  contacts: ProspectContact[];
  source: string;
};

export type SimilarityQuery = {
  industries: string[];
  employeeMin?: number;
  employeeMax?: number;
  countries: string[];
  themes: string[];
  query?: string;
  limit: number;
};

export interface EnrichmentProvider {
  readonly name: string;
  readonly live: boolean;
  findSimilar(query: SimilarityQuery): Promise<ProspectCandidate[]>;
}

/* ── Fixture adapter ─────────────────────────────────────────────────────── */

/**
 * A pool of plausible mid-market and enterprise operations buyers.
 *
 * Deliberately varied in fit so scoring has something to discriminate: some
 * match the ICP closely, some are too small, some are in the wrong geography.
 * A fixture set where everything scores 95 would make the scorer look like it
 * worked when it had nothing to do.
 */
const POOL: ProspectCandidate[] = [
  {
    name: 'Harborline Freight',
    domain: 'harborlinefreight.com',
    industry: 'Logistics',
    employeeCount: 2400,
    country: 'United States',
    location: 'Long Beach, CA',
    description: 'Drayage and intermodal carrier moving containers out of West Coast ports.',
    technologies: ['Salesforce', 'Slack', 'Snowflake', 'NetSuite'],
    growthSignal: 'Opened a third terminal this year and is hiring 8 operations coordinators',
    intentSignal: 'Head of Operations posted publicly about replacing spreadsheet-based exception tracking',
    warmPath: null,
    contacts: [
      { firstName: 'Lena', lastName: 'Ortiz', title: 'VP Operations', seniority: 'vp', email: 'lena.ortiz@harborlinefreight.com', linkedinUrl: null },
      { firstName: 'Sam', lastName: 'Whitcombe', title: 'Director of Terminal Operations', seniority: 'director', email: null, linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Kettleworth Manufacturing',
    domain: 'kettleworth.com',
    industry: 'Manufacturing',
    employeeCount: 3100,
    country: 'United States',
    location: 'Akron, OH',
    description: 'Precision components supplier to automotive and aerospace OEMs.',
    technologies: ['SAP', 'Microsoft Teams', 'Salesforce'],
    growthSignal: 'Announced a new plant in Q2',
    intentSignal: 'Job posting for a "Business Systems Analyst — workflow automation"',
    warmPath: 'Your CRO and their COO both sat on the Ohio Manufacturers Association panel',
    contacts: [
      { firstName: 'Ruth', lastName: 'Kovacs', title: 'Director of Quality Operations', seniority: 'director', email: 'r.kovacs@kettleworth.com', linkedinUrl: null },
      { firstName: 'Dermot', lastName: 'Shea', title: 'Chief Operating Officer', seniority: 'c_level', email: null, linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Pinnacle Health Partners',
    domain: 'pinnaclehealthpartners.com',
    industry: 'Healthcare',
    employeeCount: 4700,
    country: 'United States',
    location: 'Nashville, TN',
    description: 'Multi-site specialty clinic network coordinating referrals and clinical supply.',
    technologies: ['Epic', 'Salesforce', 'Slack', 'Okta'],
    growthSignal: 'Acquired two clinic groups in the last year',
    intentSignal: null,
    warmPath: null,
    contacts: [
      { firstName: 'Adaeze', lastName: 'Nwosu', title: 'VP Clinical Operations', seniority: 'vp', email: 'anwosu@pinnaclehealthpartners.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Sixpence Financial',
    domain: 'sixpencefinancial.com',
    industry: 'Financial Services',
    employeeCount: 1650,
    country: 'United States',
    location: 'Charlotte, NC',
    description: 'Regional commercial lender with a growing servicing book.',
    technologies: ['Salesforce', 'Snowflake', 'Azure AD'],
    growthSignal: 'Loan book up 30% year on year',
    intentSignal: 'Their Head of Servicing asked about SOC 2 workflow tooling in a community forum',
    warmPath: null,
    contacts: [
      { firstName: 'Marcus', lastName: 'Bell', title: 'Head of Servicing Operations', seniority: 'director', email: 'mbell@sixpencefinancial.com', linkedinUrl: null },
      { firstName: 'Joanne', lastName: 'Pryce', title: 'Chief Risk Officer', seniority: 'c_level', email: null, linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Verity Retail Group',
    domain: 'verityretailgroup.com',
    industry: 'Retail',
    employeeCount: 2050,
    country: 'United States',
    location: 'Columbus, OH',
    description: 'Specialty retail chain with 180 stores and a central replenishment team.',
    technologies: ['NetSuite', 'Slack', 'Google Workspace'],
    growthSignal: 'Opening 25 stores next year',
    intentSignal: null,
    warmPath: 'Their Director of Retail Ops previously worked at Brightpath Retail, a current customer',
    contacts: [
      { firstName: 'Priya', lastName: 'Venkatesan', title: 'Director of Retail Operations', seniority: 'director', email: 'pv@verityretailgroup.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Dunmore Utilities',
    domain: 'dunmoreutilities.com',
    industry: 'Energy',
    employeeCount: 1900,
    country: 'United States',
    location: 'Harrisburg, PA',
    description: 'Regional utility coordinating field crews and outage response.',
    technologies: ['SAP', 'Microsoft Teams', 'ServiceNow'],
    growthSignal: null,
    intentSignal: 'Published an RFI for outage-coordination software',
    warmPath: null,
    contacts: [
      { firstName: 'Calvin', lastName: 'Reese', title: 'Director of Grid Operations', seniority: 'director', email: 'creese@dunmoreutilities.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Tessera Software',
    domain: 'tesserasoftware.io',
    industry: 'SaaS',
    employeeCount: 210,
    country: 'United States',
    location: 'Boulder, CO',
    description: 'Developer analytics startup with a small revenue operations function.',
    technologies: ['HubSpot', 'Slack', 'PostHog'],
    growthSignal: 'Raised a Series A',
    intentSignal: null,
    warmPath: null,
    contacts: [
      { firstName: 'Nils', lastName: 'Aaberg', title: 'Head of Revenue Operations', seniority: 'director', email: 'nils@tesserasoftware.io', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Ashgrove Logistics UK',
    domain: 'ashgrovelogistics.co.uk',
    industry: 'Logistics',
    employeeCount: 2800,
    country: 'United Kingdom',
    location: 'Manchester, UK',
    description: 'Third-party logistics provider running regional distribution centres.',
    technologies: ['Salesforce', 'Microsoft Teams', 'Azure AD'],
    growthSignal: 'Won a national grocery contract',
    intentSignal: null,
    warmPath: null,
    contacts: [
      { firstName: 'Fiona', lastName: 'Gallagher', title: 'Operations Director', seniority: 'director', email: 'f.gallagher@ashgrovelogistics.co.uk', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Bellwether Chemicals',
    domain: 'bellwetherchem.com',
    industry: 'Manufacturing',
    employeeCount: 1250,
    country: 'United States',
    location: 'Baton Rouge, LA',
    description: 'Specialty chemicals producer with batch-release and deviation workflows.',
    technologies: ['SAP', 'Okta', 'Slack'],
    growthSignal: null,
    intentSignal: 'Hiring an Operations Excellence Manager with "workflow automation" in the brief',
    warmPath: null,
    contacts: [
      { firstName: 'Thea', lastName: 'Lindgren', title: 'Operations Excellence Lead', seniority: 'manager', email: 'tlindgren@bellwetherchem.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Crosswind Insurance',
    domain: 'crosswindins.com',
    industry: 'Financial Services',
    employeeCount: 980,
    country: 'United States',
    location: 'Des Moines, IA',
    description: 'Regional insurer handling claims exceptions across three states.',
    technologies: ['Guidewire', 'Salesforce', 'Google Workspace'],
    growthSignal: null,
    intentSignal: null,
    warmPath: null,
    contacts: [
      { firstName: 'Oscar', lastName: 'Demel', title: 'Claims Operations Manager', seniority: 'manager', email: 'odemel@crosswindins.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Northvale Construction',
    domain: 'northvaleconstruction.com',
    industry: 'Construction',
    employeeCount: 3300,
    country: 'United States',
    location: 'Denver, CO',
    description: 'Commercial contractor managing change orders across 40 active sites.',
    technologies: ['Procore', 'Microsoft Teams', 'Salesforce'],
    growthSignal: 'Backlog at a record high',
    intentSignal: null,
    warmPath: null,
    contacts: [
      { firstName: 'Deshawn', lastName: 'Mabry', title: 'Director of Project Controls', seniority: 'director', email: 'dmabry@northvaleconstruction.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
  {
    name: 'Quillon Media',
    domain: 'quillonmedia.com',
    industry: 'Media',
    employeeCount: 340,
    country: 'Canada',
    location: 'Vancouver, BC',
    description: 'Production studio coordinating post-production approvals.',
    technologies: ['Frame.io', 'Slack', 'Google Workspace'],
    growthSignal: null,
    intentSignal: null,
    warmPath: null,
    contacts: [
      { firstName: 'Margot', lastName: 'Chen', title: 'Head of Production Operations', seniority: 'director', email: 'margot@quillonmedia.com', linkedinUrl: null },
    ],
    source: 'fixture',
  },
];

class FixtureEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'fixture';
  readonly live = false;

  async findSimilar(query: SimilarityQuery): Promise<ProspectCandidate[]> {
    let pool = POOL;

    // A free-text query narrows the pool the way a provider's search would,
    // rather than being ignored.
    if (query.query) {
      const terms = query.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
      if (terms.length > 0) {
        const matched = pool.filter((candidate) => {
          const haystack = [
            candidate.name,
            candidate.industry ?? '',
            candidate.description,
            candidate.location ?? '',
            ...candidate.technologies,
          ]
            .join(' ')
            .toLowerCase();
          return terms.some((term) => haystack.includes(term));
        });
        if (matched.length > 0) pool = matched;
      }
    }

    return pool.slice(0, query.limit);
  }
}

/* ── Live adapters ───────────────────────────────────────────────────────── */

/**
 * Apollo-style adapter.
 *
 * Included to show the shape a real integration takes and to give the
 * configuration path somewhere to land. It throws a clear, actionable error
 * rather than silently returning nothing, because a prospecting list that is
 * quietly empty is worse than one that explains why.
 */
class ApolloEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'apollo';
  readonly live = true;

  constructor(private readonly apiKey: string) {}

  async findSimilar(query: SimilarityQuery): Promise<ProspectCandidate[]> {
    const res = await fetch('https://api.apollo.io/api/v1/mixed_companies/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        organization_industry_tag_ids: undefined,
        q_organization_keyword_tags: query.industries,
        organization_num_employees_ranges:
          query.employeeMin && query.employeeMax
            ? [`${query.employeeMin},${query.employeeMax}`]
            : undefined,
        page: 1,
        per_page: Math.min(query.limit, 25),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(
        `Apollo search failed (${res.status}). Check APOLLO_API_KEY and the account's plan limits.`,
      );
    }

    const json = (await res.json()) as {
      organizations?: {
        name?: string;
        primary_domain?: string;
        industry?: string;
        estimated_num_employees?: number;
        country?: string;
        city?: string;
        short_description?: string;
        technology_names?: string[];
      }[];
    };

    return (json.organizations ?? []).map((org) => ({
      name: org.name ?? 'Unknown',
      domain: org.primary_domain ?? null,
      industry: org.industry ?? null,
      employeeCount: org.estimated_num_employees ?? null,
      country: org.country ?? null,
      location: [org.city, org.country].filter(Boolean).join(', ') || null,
      description: org.short_description ?? '',
      technologies: org.technology_names ?? [],
      growthSignal: null,
      intentSignal: null,
      warmPath: null,
      // Contact enrichment is a separate, separately-billed call; the UI shows
      // "no contacts enriched" rather than inventing names.
      contacts: [],
      source: 'apollo',
    }));
  }
}

let cached: EnrichmentProvider | undefined;

export function getEnrichmentProvider(): EnrichmentProvider {
  if (cached) return cached;

  const apolloKey = process.env['APOLLO_API_KEY'];
  if (apolloKey && env.INTEGRATION_MODE === 'live') {
    cached = new ApolloEnrichmentProvider(apolloKey);
  } else {
    cached = new FixtureEnrichmentProvider();
  }
  return cached;
}

/** Test seam. */
export function __setEnrichmentProvider(provider: EnrichmentProvider | undefined): void {
  cached = provider;
}
