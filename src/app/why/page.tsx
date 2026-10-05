import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  SectionLabel,
} from '@/components/ui/primitives';
import { CLICK_JOBS, CLICK_CEILING, budgetSummary } from '@/lib/ux/click-budget';
import { absoluteUrl, SITE } from '@/lib/seo';
import { getCurrentUser } from '@/lib/auth/session';
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome';
import { VisitBeacon } from '@/components/marketing/visit-beacon';

/**
 * The comparison page — public, and deliberately so.
 *
 * This is the page a rep sends a prospect who asks "why not just use
 * Salesforce", so it has to be readable without an account. It sits outside
 * the (app) route group for that reason: no session, no sidebar, and one of
 * only two routes in the whole product that opt into being indexed.
 *
 * Written for a person, not a procurement form: short sentences, no jargon,
 * and a claim only where the product actually does the thing. The click counts
 * are read from the live manifest in lib/ux/click-budget rather than typed in,
 * so this page cannot drift into promising something the build no longer does.
 *
 * The "where the others are still better" section is deliberate. A comparison
 * page that says the competition is bad at everything reads as marketing and
 * gets discounted entirely; naming the real trade-offs is what makes the rest
 * worth believing.
 */

const TITLE = 'Why an AI-native CRM instead of Salesforce or HubSpot';
const DESCRIPTION =
  'Salesforce and HubSpot are filing cabinets somebody has to fill in. Figbolt builds the record from your email, meetings and tickets — and says where it is still the weaker choice.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  alternates: { canonical: '/why' },
  keywords: [
    'Salesforce alternative',
    'HubSpot alternative',
    'AI CRM comparison',
    'CRM without data entry',
    'agent-native CRM',
  ],
  openGraph: {
    type: 'article',
    url: absoluteUrl('/why'),
    siteName: SITE.name,
    title: TITLE,
    description: DESCRIPTION,
    locale: SITE.locale,
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export default async function WhyPage() {
  const budget = budgetSummary();
  const oneStep = CLICK_JOBS.filter((j) => j.steps.length <= 1).length;
  const signedIn = Boolean(await getCurrentUser());

  return (
    <main className="min-h-dvh bg-bg">
      <SiteHeader signedIn={signedIn} />
      <VisitBeacon path="/why" />

      <div className="mx-auto w-full max-w-5xl px-5 sm:px-8 py-10 lg:py-14">
        <header>
          <Badge tone="accent">In plain language</Badge>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text text-balance sm:text-4xl">
            Why an AI-native CRM is different
          </h1>
          <p className="mt-3 max-w-2xl text-base text-text-muted text-pretty">
            What this is, what it does that a traditional CRM does not, and where the older
            tools are still the better choice.
          </p>
        </header>

      {/* ── The one-liner ─────────────────────────────────────────────────── */}
      <Card className="mt-6 border-accent-border bg-accent-subtle">
        <CardBody className="py-6">
          <p className="text-lg font-medium text-text text-balance">
            Salesforce and HubSpot are filing cabinets. Somebody has to put the paper in.
          </p>
          <p className="mt-2.5 max-w-3xl text-sm text-text-muted text-pretty">
            Figbolt reads the email, meetings and support tickets you already have, and works
            out the customer record from them. The rep does not type it in. That one change is
            what everything else on this page follows from.
          </p>
        </CardBody>
      </Card>

      {/* ── The problem ───────────────────────────────────────────────────── */}
      <SectionLabel className="mt-10">The problem with the old way</SectionLabel>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <Plain
          title="The CRM is only as good as what people type"
          body="A deal is marked 'Proposal' because someone remembered to change a dropdown. If they were busy, the pipeline is wrong — and nobody knows which parts."
        />
        <Plain
          title="Updating it is not selling"
          body="Logging a call, writing the note, setting the follow-up, moving the stage. It is four screens for something that took ten minutes to do."
        />
        <Plain
          title="It is built for the manager"
          body="The forecast report is excellent. The rep filling it in gets very little back, which is exactly why they stop filling it in."
        />
      </div>

      {/* ── Side by side ──────────────────────────────────────────────────── */}
      <SectionLabel className="mt-10">Side by side</SectionLabel>
      <Card className="mt-3 overflow-hidden">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-subtle">
                <th className="px-4 py-2.5 text-left font-medium text-text-muted"> </th>
                <th className="px-4 py-2.5 text-left font-medium text-text-muted">
                  Salesforce / HubSpot
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-text">Figbolt</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.aspect} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 align-top font-medium text-text">{row.aspect}</td>
                  <td className="px-4 py-3 align-top text-text-muted">{row.them}</td>
                  <td className="px-4 py-3 align-top text-text">{row.us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── What makes it different ───────────────────────────────────────── */}
      <SectionLabel className="mt-10">The five things that actually differ</SectionLabel>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Point
          n={1}
          title="Nobody fills it in"
          body="Connect a mailbox and a calendar. Figbolt resolves each thread to an account, then pulls out the things that matter: what you promised, what they objected to, what they asked for, who is actually involved. Those become real records you can search and report on."
          proof="The account page is built from interactions, not from forms someone completed."
        />
        <Point
          n={2}
          title={`Everyday jobs take ${CLICK_CEILING} clicks or fewer`}
          body={`Logging a call, setting a follow-up, moving a deal, adding an account. ${budget.total} common jobs are measured against a hard ceiling, and ${oneStep} of them are a single step from anywhere via the command bar.`}
          proof={`Average ${budget.average.toFixed(1)} steps, worst case ${budget.worst}. Enforced by a test — the build fails if a job gets slower.`}
        />
        <Point
          n={3}
          title="Answers come with their evidence"
          body="Ask 'why is this deal stalled' and you get an answer that cites the specific email or transcript line behind every claim. If the evidence is thin, Bolt says so instead of producing a confident guess."
          proof="Citations are checked against what was actually retrieved, so it cannot cite a record it never read."
        />
        <Point
          n={4}
          title="It acts, but it asks first"
          body="Bolt can draft the follow-up, create the task and schedule the next meeting. Anything that changes data or reaches a customer is held for your approval, and you see the exact thing that will happen before you say yes."
          proof="The payload you approve is the payload that runs — the model is not consulted again in between."
        />
        <Point
          n={5}
          title="Other software can use it"
          body="Figbolt exposes its own tools over MCP and a REST API, with the same permission checks a person gets. Your team's other agents can read the CRM and propose changes without anyone building a one-off integration."
          proof="Same five gates for an external agent as for the built-in one."
        />
        <Point
          n={6}
          title="It learns from being corrected"
          body="Every time someone edits a draft before approving it, or rejects a suggestion, that becomes a test case. The system is measured against the cases humans already fixed, so a change that breaks something previously correct shows up immediately."
          proof="Visible on the Learning tab, including when the score goes down."
        />
      </div>

      {/* ── A worked example ──────────────────────────────────────────────── */}
      <SectionLabel className="mt-10">What that looks like after one customer call</SectionLabel>
      <Card className="mt-3">
        <CardBody>
          <ol className="space-y-3 text-sm">
            {WALKTHROUGH.map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[11px] font-semibold text-accent-text">
                  {i + 1}
                </span>
                <span className="text-text-muted text-pretty">{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-border pt-4 text-sm text-text">
            Total typing by the rep: none. Total decisions by the rep: which of the proposed
            actions to approve.
          </p>
        </CardBody>
      </Card>

      {/* ── Honest limits ─────────────────────────────────────────────────── */}
      <SectionLabel className="mt-10">Where Salesforce and HubSpot are still the better choice</SectionLabel>
      <Card className="mt-3 border-border">
        <CardHeader>
          <CardTitle className="text-sm">These are real, and worth saying out loud</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          <ul className="space-y-2.5 text-sm text-text-muted">
            {LIMITS.map((limit) => (
              <li key={limit} className="flex gap-2.5">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-text-subtle" />
                <span className="text-pretty">{limit}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <p className="mt-6 max-w-3xl text-sm text-text-muted text-pretty">
          The short version: if your problem is that you need a hundred teams on one heavily
          customised system, buy the incumbent. If your problem is that your CRM is out of date
          because nobody has time to update it, that is the problem Figbolt is built for.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-border pt-8">
          <Link
            href={signedIn ? '/home' : '/signup'}
            className="rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-sm)] transition-colors hover:bg-accent-hover"
          >
            {signedIn ? 'Go to dashboard' : 'Start free'}
          </Link>
          <Link
            href="/"
            className="rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-text-muted transition-colors hover:text-text"
          >
            Back to the overview
          </Link>
        </div>
      </div>

      <SiteFooter note="Comparisons describe generally documented product behaviour, not benchmarks." />
    </main>
  );
}


/* ── Content ────────────────────────────────────────────────────────────── */

const COMPARISON: { aspect: string; them: string; us: string }[] = [
  {
    aspect: 'Who enters the data',
    them: 'The rep, by hand, after the fact',
    us: 'Derived from email, meetings and tickets automatically',
  },
  {
    aspect: 'What the AI does',
    them: 'Summarises and drafts text for you to copy',
    us: 'Proposes the actual CRM action, ready to approve',
  },
  {
    aspect: 'Logging a call',
    them: 'Open record, pick type, write note, save, set follow-up',
    us: 'Type it in the command bar, or let the transcript do it',
  },
  {
    aspect: 'Trusting an answer',
    them: 'A number in a report; tracing it is your job',
    us: 'Every claim links to the email or transcript behind it',
  },
  {
    aspect: 'Getting set up',
    them: 'Often an implementation partner and a few months',
    us: 'Connect a mailbox; the history builds the starting picture',
  },
  {
    aspect: 'Other agents and tools',
    them: 'An API, and usually a paid tier to reach it',
    us: 'MCP server and REST API with the same permission checks',
  },
];

const WALKTHROUGH = [
  'The call happens on your normal calendar invite — Figbolt scheduled it, so it already knows which deal it belongs to.',
  'The recording comes back and is transcribed. Each line is attributed to a speaker, and anyone not recognised as a colleague is treated as the customer.',
  'Extraction reads the transcript and pulls out the summary, the decisions, the objections, the things they asked for, and the next steps that were agreed.',
  'Those next steps become proposed actions: log the summary on the account, create a task for each commitment, draft the follow-up email.',
  'They land in your approval queue showing exactly what will change. You approve the ones that are right, edit the ones that are close, and reject the rest.',
  'What you edited or rejected is recorded as a correction, and becomes a test case the system is measured against from then on.',
];

const LIMITS = [
  'Breadth of ecosystem. Salesforce has thousands of certified apps and a very large consultant market. Figbolt does not, and will not for a long time.',
  'Deep customisation. If your business needs heavily bespoke objects, validation rules and approval hierarchies modelled in the CRM itself, the incumbents are built for exactly that.',
  'Adjacent products. Marketing automation, CPQ, field service and a full support desk are separate, mature products in those suites. Figbolt is focused on the sales record.',
  'Track record. They have decades of enterprise deployments, compliance certifications and procurement familiarity behind them. That is a legitimate thing for a buyer to weigh.',
  'Automatic capture needs access. Figbolt is only as good as what it is allowed to read. A team that cannot connect mail or calendar loses most of the advantage.',
];

/* ── Small presentational pieces ───────────────────────────────────────── */

function Plain({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardBody>
        <h3 className="text-sm font-semibold text-text text-balance">{title}</h3>
        <p className="mt-1.5 text-sm text-text-muted text-pretty">{body}</p>
      </CardBody>
    </Card>
  );
}

function Point({
  n,
  title,
  body,
  proof,
}: {
  n: number;
  title: string;
  body: string;
  proof: string;
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent text-xs font-semibold text-white">
            {n}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text text-balance">{title}</h3>
            <p className="mt-1.5 text-sm text-text-muted text-pretty">{body}</p>
            <p className="mt-2.5 border-l-2 border-accent-border pl-2.5 text-xs text-text-subtle text-pretty">
              {proof}
            </p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
