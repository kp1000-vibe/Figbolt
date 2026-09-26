/**
 * The click budget.
 *
 * "Reps spend 60% of their week not selling" and "it takes too many clicks to
 * do a simple daily update" are the same complaint measured two ways. A promise
 * to fix it is worthless unless something enforces it, so the budget lives here
 * as data and `tests/click-budget.test.ts` fails the build when a job exceeds
 * it or points at a route that does not exist.
 *
 * What counts as a step: one deliberate act that advances the job — a click, or
 * an Enter that commits. Opening the command bar counts. Typing does not, the
 * same way typing into a search box is not navigation. Reading the result does
 * not.
 *
 * Why three: two is the floor for anything that writes, because a write needs
 * an intent and a confirmation. Three leaves exactly one step of slack for
 * disambiguation — picking which Acme. Past that a rep stops bothering and the
 * record rots, which is the whole disease.
 */

export const CLICK_CEILING = 3;

export type Surface =
  /** The command bar, opened with ⌘K from anywhere including a cold load. */
  | 'command'
  /** A route reached directly, by URL or a single nav click. */
  | 'route'
  /** A control already on screen in the normal flow of the job. */
  | 'inline';

export type ClickJob = {
  id: string;
  /** The job in the rep's words, not the system's. */
  job: string;
  /** Which of the cited industry problems this job is the answer to. */
  addresses: string;
  surface: Surface;
  /** Each deliberate act, in order. */
  steps: string[];
  /** Route the job starts from or lands on; asserted to exist. */
  route?: string;
  /**
   * The tool the job dispatches, if it writes. Asserted to be registered, so
   * a renamed tool cannot silently break a documented one-step job.
   */
  tool?: string;
};

export const CLICK_JOBS: ClickJob[] = [
  /* ── The jobs that eat the 60% ─────────────────────────────────────────── */
  {
    id: 'log-call',
    job: 'Log what just happened on a call',
    addresses: 'Manual data entry; 60% of the week on non-selling tasks',
    surface: 'command',
    steps: ['⌘K', 'Enter on “Log call · Acme Corp”'],
    tool: 'add_note',
  },
  {
    id: 'create-followup',
    job: 'Set a follow-up task for Friday',
    addresses: '77% of sellers struggle to finish assigned tasks',
    surface: 'command',
    steps: ['⌘K', 'Enter on “New task · Acme Corp”'],
    tool: 'create_task',
  },
  {
    id: 'move-stage',
    job: 'Move a deal to the next stage',
    addresses: '“Too many clicks to perform simple daily updates”',
    surface: 'command',
    steps: ['⌘K', 'Enter on “Move to Negotiation · Acme”'],
    tool: 'change_pipeline_stage',
  },
  {
    id: 'draft-followup',
    job: 'Draft the follow-up email after a meeting',
    addresses: 'Non-selling admin time; AI that asks before acting',
    surface: 'command',
    // Three, not two, and stated honestly: a draft that leaves the building
    // needs a human to confirm it, which is the point of the approval gate.
    steps: ['⌘K', 'Enter on “Draft follow-up · Acme Corp”', 'Review and save'],
    tool: 'draft_email',
  },
  {
    id: 'add-account',
    job: 'Add a company that just came in',
    addresses: 'Manual data entry; junk properties from bad imports',
    surface: 'command',
    steps: ['⌘K', 'Enter on “New account · Foo Ltd”'],
    tool: 'create_account',
  },

  /* ── Knowing what is true, without asking an admin ─────────────────────── */
  {
    id: 'ask-anything',
    job: 'Ask a question about a customer and get a cited answer',
    addresses: 'Only 45% of leaders trust their forecast; AI that shows why',
    surface: 'command',
    steps: ['⌘K', 'Enter'],
    route: '/ask',
  },
  {
    id: 'whats-needed-today',
    job: 'See everything that needs me today',
    addresses: 'Built for managers, not reps; 8 tools and 42% overwhelmed',
    surface: 'route',
    steps: ['Click Home'],
    route: '/home',
  },
  {
    id: 'open-record',
    job: 'Open an account and see its real state',
    addresses: 'Bad data; silos across 8 tools',
    surface: 'command',
    steps: ['⌘K', 'Enter on the account'],
    route: '/accounts',
  },
  {
    id: 'why-this-score',
    job: 'See why a deal is scored the way it is',
    addresses: '78% acted on an AI recommendation they later suspected was wrong',
    surface: 'command',
    steps: ['⌘K', 'Enter on the deal', 'Read the health panel'],
    route: '/opportunities',
  },
  {
    id: 'churn-risk',
    job: 'Find which customers are about to churn, and why',
    addresses: 'Tech silos limit AI for 51% of leaders',
    surface: 'command',
    steps: ['⌘K', 'Enter'],
    route: '/analytics',
  },

  /* ── Staying in control of the agents ──────────────────────────────────── */
  {
    id: 'approve-action',
    job: 'Approve or reject what an agent wants to do',
    addresses: 'AI that asks before acting; 58%/35% agent success rates',
    surface: 'route',
    steps: ['Click Inbox', 'Click Approve'],
    route: '/inbox',
  },
  {
    id: 'clear-commitment',
    job: 'Mark a promise you made as done',
    addresses: '77% struggle to complete assigned tasks',
    surface: 'route',
    steps: ['Click Tasks', 'Click the checkbox'],
    route: '/tasks',
  },
  {
    id: 'snooze-item',
    job: 'Push an inbox item to later',
    addresses: 'Overwhelmed sellers are 45% less likely to hit quota',
    surface: 'route',
    steps: ['Click Inbox', 'Click Snooze'],
    route: '/inbox',
  },

  /* ── Setup, without a consultant ───────────────────────────────────────── */
  {
    id: 'connect-source',
    job: 'Connect the mailbox so data stops being typed',
    addresses: '55% of rollouts miss their goals; 10-month implementations',
    surface: 'route',
    steps: ['Click Integrations', 'Click Connect'],
    route: '/integrations',
  },
  {
    id: 'build-agent',
    job: 'Create an agent by describing it in a sentence',
    addresses: 'Needs a dedicated admin and costly consultants',
    surface: 'route',
    steps: ['Click Agents', 'Click New agent', 'Describe and save'],
    route: '/agents/new',
  },
  {
    id: 'find-prospects',
    job: 'Get a list of companies like the ones that already closed',
    addresses: 'Small teams skip CRM; 8 separate tools',
    surface: 'route',
    steps: ['Click Prospecting'],
    route: '/prospecting',
  },
];

/** Jobs over budget. Empty in a healthy build; the test asserts that. */
export function overBudget(jobs: ClickJob[] = CLICK_JOBS): ClickJob[] {
  return jobs.filter((j) => j.steps.length > CLICK_CEILING);
}

export function budgetSummary(jobs: ClickJob[] = CLICK_JOBS): {
  total: number;
  oneStep: number;
  twoStep: number;
  threeStep: number;
  worst: number;
  average: number;
} {
  const counts = jobs.map((j) => j.steps.length);
  return {
    total: jobs.length,
    oneStep: counts.filter((c) => c === 1).length,
    twoStep: counts.filter((c) => c === 2).length,
    threeStep: counts.filter((c) => c === 3).length,
    worst: Math.max(...counts),
    average: counts.reduce((a, b) => a + b, 0) / counts.length,
  };
}
