/**
 * Demo workspace definition.
 *
 * The fictional company is **Northwind Labs**, selling *Northwind* — an
 * operations workflow platform sold to mid-market and enterprise ops teams.
 *
 * The data is shaped around patterns the product should be able to *discover*,
 * not just display. Each is planted across many accounts so analytics and AI
 * insights have something real to find:
 *
 *   1. Enterprise deals repeatedly hit SSO / SOC 2 as procurement blockers.
 *   2. Deals where an executive attended a call close faster and higher.
 *   3. Several accounts independently ask for the same Salesforce integration.
 *   4. A cohort of deals went quiet after pricing was shared.
 *   5. Engagement declines measurably before a deal is lost.
 *   6. Per-seat pricing draws objections specifically from large-headcount buyers.
 */

export type SeedUser = {
  key: string;
  name: string;
  email: string;
  title: string;
  role: 'owner' | 'admin' | 'manager' | 'member' | 'viewer';
};

export const DEMO_PASSWORD = 'demo1234';

export const USERS: SeedUser[] = [
  { key: 'alex', name: 'Alex Rivera', email: 'alex@northwindlabs.com', title: 'Account Executive', role: 'owner' },
  { key: 'sam', name: 'Sam Chen', email: 'sam@northwindlabs.com', title: 'VP Sales', role: 'admin' },
  { key: 'jordan', name: 'Jordan Blake', email: 'jordan@northwindlabs.com', title: 'Enterprise AE', role: 'member' },
  { key: 'priya', name: 'Priya Nair', email: 'priya@northwindlabs.com', title: 'Solutions Engineer', role: 'member' },
  { key: 'morgan', name: 'Morgan Diaz', email: 'morgan@northwindlabs.com', title: 'Account Executive', role: 'member' },
  { key: 'riley', name: 'Riley Fox', email: 'riley@northwindlabs.com', title: 'Chief Revenue Officer', role: 'manager' },
];

export const COMPANY_CONTEXT = {
  whatWeSell:
    'Northwind is an operations workflow platform. Ops teams use it to replace spreadsheet-and-email processes with auditable, automated workflows that connect to the systems they already run on.',
  idealCustomer:
    'Companies of 200–5,000 employees with a dedicated operations or business-systems team, running multi-step processes across several tools, where mistakes are expensive.',
  targetIndustries: ['Financial Services', 'Healthcare', 'Logistics', 'SaaS', 'Manufacturing', 'Retail'],
  qualificationCriteria:
    'A named operations owner feels real pain, at least 50 seats in scope, a budget holder identified, and a compelling event within two quarters.',
  salesProcess:
    'Discovery → Evaluation (technical + security) → Proposal → Negotiation → Closed. Enterprise deals add a security review and usually a procurement cycle.',
  commonObjections: [
    'Security review and SOC 2 evidence required before procurement will engage',
    'SSO/SAML is a hard requirement for enterprise rollout',
    'Per-seat pricing is expensive at large headcount',
    'Concern about migrating existing processes',
    'Already using a competing tool or an internal build',
  ],
  competitors: ['Vantage Systems', 'Coreflow', 'Tessellate', 'Loop Ops'],
  differentiators:
    'Northwind keeps a full audit trail of every workflow run, connects to existing systems without a data migration, and can be configured by ops teams without engineering support.',
};

export type Scenario =
  | 'enterprise_security'
  | 'integration_ask'
  | 'pricing_pushback'
  | 'stalled_after_pricing'
  | 'exec_engaged_fast'
  | 'expansion'
  | 'competitive_bakeoff'
  | 'early_discovery'
  | 'lost_to_competitor'
  | 'lost_to_budget'
  | 'happy_customer';

export type SeedContact = {
  firstName: string;
  lastName: string;
  title: string;
  seniority: 'c_level' | 'vp' | 'director' | 'manager' | 'ic';
  department: string;
  buyingRole:
    | 'champion'
    | 'decision_maker'
    | 'economic_buyer'
    | 'technical_evaluator'
    | 'blocker'
    | 'influencer'
    | 'end_user'
    | 'unknown';
  isPrimary?: boolean;
};

export type SeedAccount = {
  name: string;
  domain: string;
  industry: string;
  employeeCount: number;
  location: string;
  country: string;
  tier: 'enterprise' | 'mid_market' | 'smb';
  lifecycleStage: 'prospect' | 'opportunity' | 'customer' | 'churned';
  currentArr?: number;
  description: string;
  ownerKey: string;
  scenario: Scenario;
  contacts: SeedContact[];
  deal?: {
    name: string;
    value: number;
    stage: string;
    status: 'open' | 'won' | 'lost';
    /** Days ago the deal was created. */
    createdDaysAgo: number;
    /** Days from now to expected close; negative means the date has passed. */
    closeInDays: number;
    lossReason?: string;
  };
};

/** Pipeline definition. Probabilities feed the default deal probability. */
export const PIPELINE_STAGES = [
  { name: 'Discovery', probability: 10, type: 'open' as const, color: '#8b9bb4', entryCriteria: 'A named ops owner has described a real, current problem.' },
  { name: 'Evaluation', probability: 30, type: 'open' as const, color: '#5b8def', entryCriteria: 'Technical fit confirmed; security or IT review under way.' },
  { name: 'Proposal', probability: 55, type: 'open' as const, color: '#7c6df2', entryCriteria: 'Pricing shared and scope agreed with the champion.' },
  { name: 'Negotiation', probability: 78, type: 'open' as const, color: '#e0954a', entryCriteria: 'Commercial terms under discussion; legal or procurement engaged.' },
  { name: 'Closed Won', probability: 100, type: 'won' as const, color: '#3fa66b', entryCriteria: 'Contract signed.' },
  { name: 'Closed Lost', probability: 0, type: 'lost' as const, color: '#c85a5a', entryCriteria: 'The customer chose not to proceed.' },
];

export const ACCOUNTS: SeedAccount[] = [
  /* ── The hero account: the demo narrative in the brief ─────────────────── */
  {
    name: 'Acme Corp',
    domain: 'acme.com',
    industry: 'Manufacturing',
    employeeCount: 3200,
    location: 'Columbus, OH',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description:
      'Industrial equipment manufacturer running order-to-fulfilment operations across four plants. Currently coordinating exceptions by spreadsheet and email.',
    ownerKey: 'alex',
    scenario: 'enterprise_security',
    contacts: [
      { firstName: 'Dana', lastName: 'Whitfield', title: 'Director of Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Marcus', lastName: 'Feld', title: 'VP Engineering', seniority: 'vp', department: 'Engineering', buyingRole: 'technical_evaluator' },
      { firstName: 'Sarah', lastName: 'Lindqvist', title: 'CFO', seniority: 'c_level', department: 'Finance', buyingRole: 'economic_buyer' },
      { firstName: 'Tomas', lastName: 'Reyes', title: 'Information Security Lead', seniority: 'manager', department: 'Security', buyingRole: 'blocker' },
    ],
    deal: { name: 'Acme Corp — Enterprise Platform', value: 120_000, stage: 'Evaluation', status: 'open', createdDaysAgo: 62, closeInDays: 34 },
  },

  /* ── Enterprise deals that also hit SSO / SOC 2 (pattern 1) ────────────── */
  {
    name: 'Halcyon Health',
    domain: 'halcyonhealth.com',
    industry: 'Healthcare',
    employeeCount: 5400,
    location: 'Boston, MA',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Regional hospital network coordinating clinical supply and staffing workflows.',
    ownerKey: 'jordan',
    scenario: 'enterprise_security',
    contacts: [
      { firstName: 'Renee', lastName: 'Okonkwo', title: 'Director of Clinical Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Peter', lastName: 'Nash', title: 'CISO', seniority: 'c_level', department: 'Security', buyingRole: 'blocker' },
      { firstName: 'Amara', lastName: 'Singh', title: 'VP Information Systems', seniority: 'vp', department: 'IT', buyingRole: 'technical_evaluator' },
    ],
    deal: { name: 'Halcyon Health — Clinical Ops', value: 185_000, stage: 'Evaluation', status: 'open', createdDaysAgo: 78, closeInDays: 45 },
  },
  {
    name: 'Ironbridge Financial',
    domain: 'ironbridgefin.com',
    industry: 'Financial Services',
    employeeCount: 2100,
    location: 'Chicago, IL',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Commercial lender automating loan-servicing exception handling.',
    ownerKey: 'jordan',
    scenario: 'enterprise_security',
    contacts: [
      { firstName: 'Gerald', lastName: 'Moss', title: 'Head of Servicing Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Yuki', lastName: 'Tanaka', title: 'Director of Information Security', seniority: 'director', department: 'Security', buyingRole: 'technical_evaluator' },
      { firstName: 'Bianca', lastName: 'Duarte', title: 'COO', seniority: 'c_level', department: 'Executive', buyingRole: 'economic_buyer' },
    ],
    deal: { name: 'Ironbridge — Servicing Automation', value: 145_000, stage: 'Proposal', status: 'open', createdDaysAgo: 95, closeInDays: 21 },
  },
  {
    name: 'Cascade Logistics',
    domain: 'cascadelogistics.com',
    industry: 'Logistics',
    employeeCount: 4100,
    location: 'Seattle, WA',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Freight brokerage managing carrier exceptions across three regional hubs.',
    ownerKey: 'alex',
    scenario: 'enterprise_security',
    contacts: [
      { firstName: 'Miles', lastName: 'Carrington', title: 'VP Operations', seniority: 'vp', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Nadia', lastName: 'Petrov', title: 'IT Security Manager', seniority: 'manager', department: 'Security', buyingRole: 'blocker' },
      { firstName: 'Owen', lastName: 'Brady', title: 'CFO', seniority: 'c_level', department: 'Finance', buyingRole: 'economic_buyer' },
    ],
    deal: { name: 'Cascade — Exception Management', value: 96_000, stage: 'Negotiation', status: 'open', createdDaysAgo: 110, closeInDays: 12 },
  },

  /* ── Executive engaged → faster, larger (pattern 2) ────────────────────── */
  {
    name: 'Brightpath Retail',
    domain: 'brightpathretail.com',
    industry: 'Retail',
    employeeCount: 1800,
    location: 'Austin, TX',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'customer',
    currentArr: 168_000,
    description: 'Specialty retail chain automating store-level replenishment approvals.',
    ownerKey: 'morgan',
    scenario: 'exec_engaged_fast',
    contacts: [
      { firstName: 'Elena', lastName: 'Vasquez', title: 'COO', seniority: 'c_level', department: 'Executive', buyingRole: 'economic_buyer', isPrimary: true },
      { firstName: 'Chris', lastName: 'Aldridge', title: 'Director of Retail Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion' },
    ],
    deal: { name: 'Brightpath — Replenishment Ops', value: 168_000, stage: 'Closed Won', status: 'won', createdDaysAgo: 140, closeInDays: -41 },
  },
  {
    name: 'Vertex Manufacturing',
    domain: 'vertexmfg.com',
    industry: 'Manufacturing',
    employeeCount: 2600,
    location: 'Detroit, MI',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'customer',
    currentArr: 142_000,
    description: 'Automotive parts supplier running quality-hold workflows across plants.',
    ownerKey: 'jordan',
    scenario: 'exec_engaged_fast',
    contacts: [
      { firstName: 'Harold', lastName: 'Kim', title: 'Chief Operating Officer', seniority: 'c_level', department: 'Executive', buyingRole: 'economic_buyer', isPrimary: true },
      { firstName: 'Julia', lastName: 'Bergman', title: 'Plant Operations Manager', seniority: 'manager', department: 'Operations', buyingRole: 'champion' },
    ],
    deal: { name: 'Vertex — Quality Hold Workflows', value: 142_000, stage: 'Closed Won', status: 'won', createdDaysAgo: 175, closeInDays: -128 },
  },
  {
    name: 'Solstice Energy',
    domain: 'solsticeenergy.com',
    industry: 'Energy',
    employeeCount: 900,
    location: 'Denver, CO',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'customer',
    currentArr: 88_000,
    description: 'Renewable energy operator automating field-service dispatch approvals.',
    ownerKey: 'morgan',
    scenario: 'exec_engaged_fast',
    contacts: [
      { firstName: 'Nina', lastName: 'Okafor', title: 'VP Field Operations', seniority: 'vp', department: 'Operations', buyingRole: 'economic_buyer', isPrimary: true },
      { firstName: 'Ravi', lastName: 'Chandra', title: 'Operations Analyst', seniority: 'ic', department: 'Operations', buyingRole: 'champion' },
    ],
    deal: { name: 'Solstice — Field Dispatch', value: 88_000, stage: 'Closed Won', status: 'won', createdDaysAgo: 120, closeInDays: -19 },
  },

  /* ── Shared integration demand (pattern 3) ─────────────────────────────── */
  {
    name: 'Lumen Software',
    domain: 'lumensoftware.io',
    industry: 'SaaS',
    employeeCount: 640,
    location: 'San Francisco, CA',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'opportunity',
    description: 'Developer tooling company automating customer-onboarding handoffs.',
    ownerKey: 'morgan',
    scenario: 'integration_ask',
    contacts: [
      { firstName: 'Theo', lastName: 'Marchetti', title: 'Director of Revenue Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Grace', lastName: 'Hollis', title: 'VP Customer Success', seniority: 'vp', department: 'Customer Success', buyingRole: 'influencer' },
    ],
    deal: { name: 'Lumen — RevOps Automation', value: 54_000, stage: 'Proposal', status: 'open', createdDaysAgo: 40, closeInDays: 25 },
  },
  {
    name: 'Kestrel Analytics',
    domain: 'kestrelanalytics.com',
    industry: 'SaaS',
    employeeCount: 380,
    location: 'Toronto, ON',
    country: 'Canada',
    tier: 'mid_market',
    lifecycleStage: 'opportunity',
    description: 'Analytics vendor coordinating professional-services delivery workflows.',
    ownerKey: 'alex',
    scenario: 'integration_ask',
    contacts: [
      { firstName: 'Simone', lastName: 'Beaulieu', title: 'Head of Delivery Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Dev', lastName: 'Anand', title: 'Sales Operations Manager', seniority: 'manager', department: 'Sales', buyingRole: 'technical_evaluator' },
    ],
    deal: { name: 'Kestrel — Delivery Ops', value: 47_500, stage: 'Evaluation', status: 'open', createdDaysAgo: 33, closeInDays: 40 },
  },
  {
    name: 'Northgate Insurance',
    domain: 'northgateins.com',
    industry: 'Financial Services',
    employeeCount: 1500,
    location: 'Hartford, CT',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Specialty insurer automating claims-exception routing.',
    ownerKey: 'jordan',
    scenario: 'integration_ask',
    contacts: [
      { firstName: 'Wendy', lastName: 'Ashcroft', title: 'VP Claims Operations', seniority: 'vp', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Luis', lastName: 'Ferreira', title: 'Business Systems Lead', seniority: 'manager', department: 'IT', buyingRole: 'technical_evaluator' },
    ],
    deal: { name: 'Northgate — Claims Routing', value: 78_000, stage: 'Discovery', status: 'open', createdDaysAgo: 18, closeInDays: 72 },
  },
  {
    name: 'Pinecrest Media',
    domain: 'pinecrestmedia.com',
    industry: 'Media',
    employeeCount: 420,
    location: 'Los Angeles, CA',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'customer',
    currentArr: 36_000,
    description: 'Media production group coordinating post-production approvals.',
    ownerKey: 'morgan',
    scenario: 'integration_ask',
    contacts: [
      { firstName: 'Camille', lastName: 'Boyd', title: 'Head of Production Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
    deal: { name: 'Pinecrest — Production Ops Expansion', value: 28_000, stage: 'Proposal', status: 'open', createdDaysAgo: 27, closeInDays: 30 },
  },

  /* ── Pricing pushback at scale (pattern 6) ─────────────────────────────── */
  {
    name: 'Continental Freight',
    domain: 'continentalfreight.com',
    industry: 'Logistics',
    employeeCount: 6800,
    location: 'Memphis, TN',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'National freight carrier evaluating dock-scheduling automation.',
    ownerKey: 'jordan',
    scenario: 'pricing_pushback',
    contacts: [
      { firstName: 'Barbara', lastName: 'Nunez', title: 'SVP Operations', seniority: 'vp', department: 'Operations', buyingRole: 'economic_buyer', isPrimary: true },
      { firstName: 'Keith', lastName: 'Dolan', title: 'Director of Terminal Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion' },
    ],
    deal: { name: 'Continental — Dock Scheduling', value: 210_000, stage: 'Negotiation', status: 'open', createdDaysAgo: 88, closeInDays: 18 },
  },
  {
    name: 'Summit Home Services',
    domain: 'summithomeservices.com',
    industry: 'Services',
    employeeCount: 3400,
    location: 'Phoenix, AZ',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Home services franchise network standardising job-dispatch workflows.',
    ownerKey: 'morgan',
    scenario: 'pricing_pushback',
    contacts: [
      { firstName: 'Derek', lastName: 'Ivanov', title: 'VP Franchise Operations', seniority: 'vp', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Alicia', lastName: 'Moreno', title: 'Director of Finance', seniority: 'director', department: 'Finance', buyingRole: 'economic_buyer' },
    ],
    deal: { name: 'Summit — Dispatch Standardisation', value: 132_000, stage: 'Proposal', status: 'open', createdDaysAgo: 56, closeInDays: 28 },
  },

  /* ── Stalled after pricing (patterns 4 + 5) ────────────────────────────── */
  {
    name: 'Redwood Biosciences',
    domain: 'redwoodbio.com',
    industry: 'Healthcare',
    employeeCount: 720,
    location: 'San Diego, CA',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'opportunity',
    description: 'Clinical research organisation evaluating protocol-deviation workflows.',
    ownerKey: 'alex',
    scenario: 'stalled_after_pricing',
    contacts: [
      { firstName: 'Hannah', lastName: 'Weiss', title: 'Director of Clinical Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Victor', lastName: 'Lam', title: 'VP Quality', seniority: 'vp', department: 'Quality', buyingRole: 'influencer' },
    ],
    deal: { name: 'Redwood — Protocol Deviations', value: 62_000, stage: 'Proposal', status: 'open', createdDaysAgo: 71, closeInDays: -4 },
  },
  {
    name: 'Atlas Property Group',
    domain: 'atlaspropertygroup.com',
    industry: 'Real Estate',
    employeeCount: 540,
    location: 'Miami, FL',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'opportunity',
    description: 'Commercial property manager automating maintenance escalations.',
    ownerKey: 'morgan',
    scenario: 'stalled_after_pricing',
    contacts: [
      { firstName: 'Rosa', lastName: 'Delgado', title: 'Director of Property Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
    deal: { name: 'Atlas — Maintenance Escalations', value: 44_000, stage: 'Proposal', status: 'open', createdDaysAgo: 84, closeInDays: -11 },
  },
  {
    name: 'Beacon Utilities',
    domain: 'beaconutilities.com',
    industry: 'Energy',
    employeeCount: 2200,
    location: 'Portland, OR',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Regional utility evaluating outage-response coordination.',
    ownerKey: 'alex',
    scenario: 'stalled_after_pricing',
    contacts: [
      { firstName: 'Gordon', lastName: 'Fraser', title: 'Director of Grid Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Maya', lastName: 'Rathod', title: 'IT Program Manager', seniority: 'manager', department: 'IT', buyingRole: 'technical_evaluator' },
    ],
    deal: { name: 'Beacon — Outage Coordination', value: 118_000, stage: 'Evaluation', status: 'open', createdDaysAgo: 102, closeInDays: 8 },
  },

  /* ── Competitive bake-offs (pattern for objection analytics) ───────────── */
  {
    name: 'Orchard Foods',
    domain: 'orchardfoods.com',
    industry: 'Manufacturing',
    employeeCount: 1900,
    location: 'Minneapolis, MN',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'opportunity',
    description: 'Food producer comparing workflow vendors for recall-readiness processes.',
    ownerKey: 'jordan',
    scenario: 'competitive_bakeoff',
    contacts: [
      { firstName: 'Patrick', lastName: 'Oyelaran', title: 'Director of Supply Chain Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Ingrid', lastName: 'Salomon', title: 'VP Quality & Compliance', seniority: 'vp', department: 'Quality', buyingRole: 'decision_maker' },
    ],
    deal: { name: 'Orchard — Recall Readiness', value: 91_000, stage: 'Evaluation', status: 'open', createdDaysAgo: 49, closeInDays: 38 },
  },
  {
    name: 'Meridian Telecom',
    domain: 'meridiantelecom.com',
    industry: 'Telecommunications',
    employeeCount: 3100,
    location: 'Atlanta, GA',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'prospect',
    description: 'Telecom operator running a formal vendor evaluation for provisioning workflows.',
    ownerKey: 'jordan',
    scenario: 'competitive_bakeoff',
    contacts: [
      { firstName: 'Colin', lastName: 'Duffy', title: 'Head of Network Operations', seniority: 'director', department: 'Operations', buyingRole: 'influencer', isPrimary: true },
      { firstName: 'Fatima', lastName: 'Haddad', title: 'Procurement Lead', seniority: 'manager', department: 'Procurement', buyingRole: 'blocker' },
    ],
    deal: { name: 'Meridian — Provisioning Workflows', value: 155_000, stage: 'Discovery', status: 'open', createdDaysAgo: 15, closeInDays: 90 },
  },

  /* ── Closed lost, for analytics to learn from ──────────────────────────── */
  {
    name: 'Fairview Systems',
    domain: 'fairviewsystems.com',
    industry: 'SaaS',
    employeeCount: 880,
    location: 'Raleigh, NC',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'prospect',
    description: 'Chose a competitor after a three-vendor evaluation.',
    ownerKey: 'alex',
    scenario: 'lost_to_competitor',
    contacts: [
      { firstName: 'Neil', lastName: 'Abrams', title: 'Director of Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
    deal: {
      name: 'Fairview — Ops Automation',
      value: 58_000,
      stage: 'Closed Lost',
      status: 'lost',
      createdDaysAgo: 190,
      closeInDays: -84,
      lossReason: 'Lost to Vantage Systems on existing vendor relationship and integration depth.',
    },
  },
  {
    name: 'Clearwater Municipal',
    domain: 'clearwatermunicipal.gov',
    industry: 'Public Sector',
    employeeCount: 1200,
    location: 'Tampa, FL',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'prospect',
    description: 'Budget was reallocated mid-cycle; revisit next fiscal year.',
    ownerKey: 'morgan',
    scenario: 'lost_to_budget',
    contacts: [
      { firstName: 'Arthur', lastName: 'Bello', title: 'Deputy Director of Public Works', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
    deal: {
      name: 'Clearwater — Permit Workflows',
      value: 39_000,
      stage: 'Closed Lost',
      status: 'lost',
      createdDaysAgo: 210,
      closeInDays: -102,
      lossReason: 'Budget reallocated to an infrastructure programme. Revisit in the next fiscal year.',
    },
  },
  {
    name: 'Sable Chemicals',
    domain: 'sablechemicals.com',
    industry: 'Manufacturing',
    employeeCount: 1400,
    location: 'Houston, TX',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'prospect',
    description: 'Stalled on a security review that never completed.',
    ownerKey: 'jordan',
    scenario: 'lost_to_competitor',
    contacts: [
      { firstName: 'Ruth', lastName: 'Ellery', title: 'Operations Excellence Lead', seniority: 'manager', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Stefan', lastName: 'Bauer', title: 'Head of IT Security', seniority: 'director', department: 'Security', buyingRole: 'blocker' },
    ],
    deal: {
      name: 'Sable — Batch Exception Handling',
      value: 104_000,
      stage: 'Closed Lost',
      status: 'lost',
      createdDaysAgo: 240,
      closeInDays: -60,
      lossReason: 'Security review never completed; the sponsor left and the project lost its owner.',
    },
  },

  /* ── Existing customers, expansion and renewal ─────────────────────────── */
  {
    name: 'Willow Creek Bank',
    domain: 'willowcreekbank.com',
    industry: 'Financial Services',
    employeeCount: 1100,
    location: 'Nashville, TN',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'customer',
    currentArr: 74_000,
    description: 'Community bank using Northwind for account-opening exceptions; evaluating expansion into lending ops.',
    ownerKey: 'alex',
    scenario: 'expansion',
    contacts: [
      { firstName: 'Trevor', lastName: 'Nakamura', title: 'VP Retail Operations', seniority: 'vp', department: 'Operations', buyingRole: 'champion', isPrimary: true },
      { firstName: 'Denise', lastName: 'Okoro', title: 'Head of Lending Operations', seniority: 'director', department: 'Operations', buyingRole: 'decision_maker' },
    ],
    deal: { name: 'Willow Creek — Lending Ops Expansion', value: 52_000, stage: 'Negotiation', status: 'open', createdDaysAgo: 36, closeInDays: 15 },
  },
  {
    name: 'Granite Construction Partners',
    domain: 'graniteconstruction.co',
    industry: 'Construction',
    employeeCount: 2400,
    location: 'Salt Lake City, UT',
    country: 'United States',
    tier: 'enterprise',
    lifecycleStage: 'customer',
    currentArr: 96_000,
    description: 'Commercial contractor using Northwind for change-order approvals across sites.',
    ownerKey: 'morgan',
    scenario: 'happy_customer',
    contacts: [
      { firstName: 'Marisol', lastName: 'Vega', title: 'Director of Project Controls', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
  },
  {
    name: 'Ashford Education Group',
    domain: 'ashfordedu.org',
    industry: 'Education',
    employeeCount: 980,
    location: 'Philadelphia, PA',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'customer',
    currentArr: 41_000,
    description: 'Education network using Northwind for enrolment exception workflows.',
    ownerKey: 'alex',
    scenario: 'happy_customer',
    contacts: [
      { firstName: 'Priscilla', lastName: 'Adeyemi', title: 'Director of Student Operations', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
  },

  /* ── Early-stage prospects ─────────────────────────────────────────────── */
  {
    name: 'Tidewater Marine',
    domain: 'tidewatermarine.com',
    industry: 'Logistics',
    employeeCount: 760,
    location: 'Norfolk, VA',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'opportunity',
    description: 'Port services operator exploring berth-scheduling automation.',
    ownerKey: 'morgan',
    scenario: 'early_discovery',
    contacts: [
      { firstName: 'Sandra', lastName: 'Bright', title: 'Operations Manager', seniority: 'manager', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
    deal: { name: 'Tidewater — Berth Scheduling', value: 34_000, stage: 'Discovery', status: 'open', createdDaysAgo: 9, closeInDays: 85 },
  },
  {
    name: 'Nimbus Cloud Services',
    domain: 'nimbuscloud.io',
    industry: 'SaaS',
    employeeCount: 290,
    location: 'Denver, CO',
    country: 'United States',
    tier: 'smb',
    lifecycleStage: 'opportunity',
    description: 'Managed services provider looking at incident-escalation workflows.',
    ownerKey: 'alex',
    scenario: 'early_discovery',
    contacts: [
      { firstName: 'Isaac', lastName: 'Romero', title: 'Head of Service Delivery', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
    deal: { name: 'Nimbus — Incident Escalation', value: 22_000, stage: 'Discovery', status: 'open', createdDaysAgo: 6, closeInDays: 60 },
  },
  {
    name: 'Larkspur Apparel',
    domain: 'larkspurapparel.com',
    industry: 'Retail',
    employeeCount: 610,
    location: 'New York, NY',
    country: 'United States',
    tier: 'mid_market',
    lifecycleStage: 'prospect',
    description: 'Apparel brand evaluating returns-processing automation.',
    ownerKey: 'morgan',
    scenario: 'early_discovery',
    contacts: [
      { firstName: 'Yvonne', lastName: 'Castille', title: 'Director of Fulfilment', seniority: 'director', department: 'Operations', buyingRole: 'champion', isPrimary: true },
    ],
  },
  {
    name: 'Copperfield Mining',
    domain: 'copperfieldmining.com',
    industry: 'Mining',
    employeeCount: 3300,
    location: 'Calgary, AB',
    country: 'Canada',
    tier: 'enterprise',
    lifecycleStage: 'prospect',
    description: 'Resource operator with safety-incident workflows still on paper.',
    ownerKey: 'jordan',
    scenario: 'early_discovery',
    contacts: [
      { firstName: 'Duncan', lastName: 'Roy', title: 'Head of Health & Safety Operations', seniority: 'director', department: 'Operations', buyingRole: 'influencer', isPrimary: true },
    ],
  },
];

/** Knowledge base documents agents cite when answering. */
export const KNOWLEDGE_DOCS = [
  {
    title: 'Northwind Security Overview',
    category: 'security' as const,
    content: `# Northwind Security Overview

## Certifications
Northwind holds **SOC 2 Type II** attestation, renewed annually. The current report covers
the twelve months ending in the most recent audit period and is available under NDA.
An ISO 27001 certification programme is in progress with target completion next year.

## Authentication
Northwind supports **SAML 2.0 single sign-on** with Okta, Azure AD / Microsoft Entra ID,
Google Workspace, OneLogin and any SAML-compliant provider. SSO is included in the
Enterprise plan at no additional cost. **SCIM 2.0 user provisioning and deprovisioning**
is available on Enterprise.

## Data protection
All data is encrypted in transit with TLS 1.3 and at rest with AES-256. Customer data is
logically isolated per workspace. EU data residency is available on Enterprise plans;
data for those workspaces is processed and stored within the EU.

## Access and audit
Role-based access control with five roles. Every configuration change, workflow run and
data export is recorded in an immutable audit log, exportable via API.

## Testing
Third-party penetration tests are performed twice yearly by an independent firm.
Executive summaries are available under NDA. Critical findings are remediated within
30 days per our vulnerability management policy.

## Subprocessors and agreements
A current subprocessor list, our standard DPA, and GDPR/CCPA commitments are published
in the trust centre. We will sign a customer paper DPA where required.

## Typical security review timeline
A standard enterprise security review takes two to three weeks from questionnaire receipt.
Providing the SOC 2 report and completing the questionnaire in the same week is the single
biggest lever on that timeline.`,
    tags: ['security', 'soc2', 'sso', 'compliance'],
  },
  {
    title: 'Pricing and Packaging',
    category: 'pricing' as const,
    content: `# Northwind Pricing and Packaging

## Plans

**Team** — $18 per user / month, billed annually. Up to 50 users. Core workflows,
standard integrations, email support.

**Business** — $32 per user / month, billed annually. Unlimited workflows, advanced
conditional logic, API access, priority support, 99.9% uptime SLA.

**Enterprise** — custom, typically $95,000–$250,000 annually. Everything in Business plus
SAML SSO, SCIM provisioning, audit log export, EU data residency, sandbox environment,
a named customer success manager, and a 99.95% uptime SLA.

## Discounting
Standard discount authority is 10% for an AE and 20% for a manager. Anything beyond 20%
requires CRO approval. Multi-year commitments earn an additional 5% per year, up to 15%.

## Handling per-seat objections at large headcount
Above roughly 1,500 seats, per-seat pricing frequently draws an objection. Two approved
responses:
1. **Tiered seat bands** — effective per-seat cost declines in bands above 1,000 seats.
2. **Platform licence** — a flat annual fee covering the whole organisation, priced from
   the value of the workflows automated rather than headcount. Requires CRO approval.

Position on cost avoided rather than list price: customers typically replace 15–30 hours
of manual coordination per operations employee per month.`,
    tags: ['pricing', 'discounting', 'packaging'],
  },
  {
    title: 'Competitive Battlecard — Vantage Systems',
    category: 'battlecard' as const,
    content: `# Battlecard: Vantage Systems

## Who they are
The incumbent in large enterprise workflow automation. Long-established, deep
professional-services motion, strong existing relationships in financial services and
manufacturing.

## Where they win
- Existing enterprise agreements make them the path of least resistance.
- Deep, mature integrations with legacy ERP systems.
- A large services organisation for complex bespoke implementations.

## Where we win
- **Time to value.** Northwind deploys in weeks; Vantage engagements routinely run
  six to nine months and carry six-figure services fees.
- **Ops-team ownership.** Northwind workflows are configured by operations staff.
  Vantage changes typically require their services team or internal engineering.
- **Total cost.** Vantage licence plus mandatory services is usually 2–3x our total.
- **Audit trail.** Ours is on by default and exportable; theirs is an add-on module.

## Questions that reframe the evaluation
- "When you need to change a workflow, who makes the change and how long does it take?"
- "What did the last implementation actually cost including services?"
- "How many workflows are live today versus how many you planned?"

## Do not
Do not disparage Vantage. In head-to-head evaluations we win on time-to-value and who
holds the keys — not on feature checklists, where they will out-list us.`,
    tags: ['competitive', 'vantage', 'battlecard'],
  },
  {
    title: 'Enterprise Qualification Framework',
    category: 'methodology' as const,
    content: `# Enterprise Qualification Framework

A Northwind enterprise opportunity is qualified when all five are true.

## 1. Named operations owner with current pain
A specific person owns the broken process and can describe what it costs them today —
in hours, errors, or escalations. "We're exploring automation" is not pain.

## 2. Scope of at least 50 seats
Below 50 seats the Business plan is the right fit and the enterprise motion is
uneconomic for both sides.

## 3. Identified economic buyer
Someone who can commit the budget, by name. **Deals where the economic buyer has not
joined a call by the Proposal stage close at roughly half the rate of those where they
have.** Getting them into the room early is the highest-leverage action in the cycle.

## 4. Compelling event within two quarters
A specific date something must be true by: an audit, a system sunset, a go-live, a
regulatory deadline. Without one, the deal has no forcing function and will slip.

## 5. Security path understood
For enterprise, know before Proposal: who runs the security review, what evidence they
need, and how long their process takes. **Deals that reach Proposal without a mapped
security path slip by two to three weeks on average.**

## Stage entry criteria
- **Evaluation** — technical fit confirmed and the security review has a named owner.
- **Proposal** — pricing shared, scope agreed with the champion, economic buyer identified.
- **Negotiation** — commercial terms under discussion with procurement or legal engaged.`,
    tags: ['methodology', 'qualification', 'process'],
  },
  {
    title: 'Northwind Product Overview',
    category: 'product' as const,
    content: `# Northwind Product Overview

## What it does
Northwind replaces spreadsheet-and-email operational processes with structured,
auditable workflows. Ops teams define steps, owners, conditions and escalations in a
visual builder — no engineering required.

## Core capabilities
- **Workflow builder** — branching, parallel steps, conditional routing, SLA timers.
- **Approvals** — multi-stage approvals with delegation and escalation on timeout.
- **Exception handling** — route anomalies to the right person with full context.
- **Audit trail** — every run, decision and data change recorded immutably.
- **Analytics** — cycle time, bottleneck and SLA-breach reporting per workflow.

## Integrations
Available today: Slack, Microsoft Teams, Gmail, Outlook, Google Sheets, Jira,
ServiceNow, NetSuite, SAP (via connector), Snowflake export, REST API, webhooks.

**In development:** a native Salesforce integration — bidirectional record sync and
workflow triggers on Salesforce events. This is the single most requested integration
from our pipeline. Currently targeted for the next two quarters; no committed GA date,
and it must not be positioned as committed to a customer.

## Deployment
Cloud-hosted, multi-tenant by default. EU data residency on Enterprise. Typical
enterprise implementation is four to six weeks, most of which is process mapping
rather than technical work.`,
    tags: ['product', 'integrations', 'capabilities'],
  },
  {
    title: 'Discovery Call Playbook',
    category: 'playbook' as const,
    content: `# Discovery Call Playbook

## Objective
Leave the call able to write down, in the customer's own words: the broken process, what
it costs, who owns fixing it, and what happens if nothing changes.

## Opening
Skip the company overview. Open with: "Walk me through what happens today when
[the process] goes wrong."

## The four questions that matter
1. **Volume and cost** — "How often does that happen, and how long does each one take?"
2. **Consequence** — "What's the impact when one falls through the cracks?"
3. **Prior attempts** — "What have you already tried?" (Reveals build-vs-buy history and
   what failed before.)
4. **Compelling event** — "Why now, rather than six months from now?"

## Before the call ends
- Agree a specific next step with a date on it.
- Ask who else needs to be involved, especially who owns the budget.
- Ask how their security review works if there is any chance of an enterprise deal.

## Anti-patterns
- Demoing before you understand the process. A demo without context is a feature tour.
- Accepting "we're just looking at options" as an answer to why now.
- Leaving without a date. A next step without a date is not a next step.`,
    tags: ['playbook', 'discovery', 'process'],
  },
];

/**
 * Secondary contacts.
 *
 * Real buying committees have people who attend one call and never speak
 * again. Including them keeps the relationship graph honest and gives
 * "who else is involved?" a non-trivial answer, without inventing a
 * buying role the conversations don't support.
 */
export const SECONDARY_CONTACTS: SeedContact[][] = [
  [
    { firstName: 'Casey', lastName: 'Lund', title: 'Operations Analyst', seniority: 'ic', department: 'Operations', buyingRole: 'end_user' },
    { firstName: 'Ellis', lastName: 'Mbeki', title: 'Business Systems Analyst', seniority: 'ic', department: 'IT', buyingRole: 'end_user' },
  ],
  [
    { firstName: 'Robin', lastName: 'Sato', title: 'Procurement Manager', seniority: 'manager', department: 'Procurement', buyingRole: 'influencer' },
    { firstName: 'Avery', lastName: 'Thorne', title: 'Process Improvement Lead', seniority: 'manager', department: 'Operations', buyingRole: 'end_user' },
  ],
  [
    { firstName: 'Noor', lastName: 'Haddadi', title: 'Senior Operations Coordinator', seniority: 'ic', department: 'Operations', buyingRole: 'end_user' },
  ],
  [
    { firstName: 'Quinn', lastName: 'Rasmussen', title: 'Director of IT', seniority: 'director', department: 'IT', buyingRole: 'influencer' },
    { firstName: 'Blake', lastName: 'Osei', title: 'Operations Team Lead', seniority: 'manager', department: 'Operations', buyingRole: 'end_user' },
  ],
];

/**
 * Additional deals so the pipeline board has depth at every stage, including
 * renewals and second-team expansions on existing customers.
 */
export const ADDITIONAL_DEALS: {
  accountName: string;
  name: string;
  value: number;
  stage: string;
  status: 'open' | 'won' | 'lost';
  createdDaysAgo: number;
  closeInDays: number;
  lossReason?: string;
}[] = [
  { accountName: 'Brightpath Retail', name: 'Brightpath — Distribution Centre Rollout', value: 74_000, stage: 'Proposal', status: 'open', createdDaysAgo: 31, closeInDays: 26 },
  { accountName: 'Vertex Manufacturing', name: 'Vertex — Second Plant Expansion', value: 66_000, stage: 'Negotiation', status: 'open', createdDaysAgo: 44, closeInDays: 11 },
  { accountName: 'Granite Construction Partners', name: 'Granite — Renewal FY27', value: 104_000, stage: 'Negotiation', status: 'open', createdDaysAgo: 22, closeInDays: 41 },
  { accountName: 'Ashford Education Group', name: 'Ashford — Renewal FY27', value: 44_000, stage: 'Proposal', status: 'open', createdDaysAgo: 19, closeInDays: 52 },
  { accountName: 'Pinecrest Media', name: 'Pinecrest — Renewal FY27', value: 38_000, stage: 'Discovery', status: 'open', createdDaysAgo: 12, closeInDays: 68 },
  { accountName: 'Solstice Energy', name: 'Solstice — Safety Workflows', value: 41_000, stage: 'Evaluation', status: 'open', createdDaysAgo: 29, closeInDays: 47 },
  { accountName: 'Larkspur Apparel', name: 'Larkspur — Returns Processing', value: 31_000, stage: 'Discovery', status: 'open', createdDaysAgo: 11, closeInDays: 74 },
  { accountName: 'Copperfield Mining', name: 'Copperfield — Safety Incident Workflows', value: 87_000, stage: 'Discovery', status: 'open', createdDaysAgo: 13, closeInDays: 96 },
  { accountName: 'Willow Creek Bank', name: 'Willow Creek — Account Opening (initial)', value: 74_000, stage: 'Closed Won', status: 'won', createdDaysAgo: 265, closeInDays: -196 },
  { accountName: 'Kestrel Analytics', name: 'Kestrel — Pilot', value: 12_000, stage: 'Closed Won', status: 'won', createdDaysAgo: 150, closeInDays: -30 },
  { accountName: 'Meridian Telecom', name: 'Meridian — Pilot Scope (declined)', value: 45_000, stage: 'Closed Lost', status: 'lost', createdDaysAgo: 230, closeInDays: -150, lossReason: 'Pilot scope rejected by procurement as too narrow to evaluate against the incumbent.' },
  { accountName: 'Tidewater Marine', name: 'Tidewater — Yard Ops (earlier attempt)', value: 26_000, stage: 'Closed Lost', status: 'lost', createdDaysAgo: 300, closeInDays: -210, lossReason: 'No compelling event; the sponsor could not secure budget without one.' },
];
