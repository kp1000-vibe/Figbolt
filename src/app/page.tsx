import type { Metadata } from 'next';
import { Bodoni_Moda } from 'next/font/google';
import Link from 'next/link';
import { LogoTile } from '@/components/brand/logo';
import { MARKETING_LINKS } from '@/components/marketing/site-chrome';
import { VisitBeacon } from '@/components/marketing/visit-beacon';
import { getCurrentUser } from '@/lib/auth/session';
import { absoluteUrl, productJsonLd, jsonLdScript, HOME_FAQS, SITE } from '@/lib/seo';

/**
 * The one route that opts into being indexed.
 *
 * The root layout defaults every page to noindex because nearly all of them
 * hold customer data; this page overrides that explicitly. If you add another
 * public page, add it here and to PUBLIC_ROUTES in src/lib/seo.ts so the
 * sitemap agrees with the meta tags.
 */
/**
 * The display face for the hero.
 *
 * A true Didone: the high stroke contrast is what makes a single sentence feel
 * composed rather than typed, and it is the one place on this page where the
 * type is the design. Loaded through next/font so it is self-hosted and
 * cannot shift the layout as it arrives.
 */
const display = Bodoni_Moda({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-display',
});

export const metadata: Metadata = {
  title: `${SITE.name} — ${SITE.category}`,
  description: SITE.description,
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  keywords: [
    'AI CRM',
    'agent-native CRM',
    'CRM without data entry',
    'automatic CRM data capture',
    'AI sales assistant',
    'MCP CRM',
    'CRM for small sales teams',
  ],
  openGraph: {
    type: 'website',
    url: absoluteUrl('/'),
    siteName: SITE.name,
    title: `${SITE.name} — ${SITE.category}`,
    description: SITE.description,
    locale: SITE.locale,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE.name} — ${SITE.category}`,
    description: SITE.description,
  },
};

/**
 * The marketing site for figbolt.com.
 *
 * Deliberately the same route as the app rather than a separate project: it
 * reuses the product's own design tokens, so the landing page and the product
 * cannot drift apart. Signed-in visitors get a "Go to dashboard" CTA instead
 * of being bounced, so the page is reachable as a real website either way.
 */
export default async function LandingPage() {
  const user = await getCurrentUser();
  const signedIn = Boolean(user);

  return (
    <main className={`min-h-dvh bg-bg ${display.variable}`}>
      <VisitBeacon path="/" />
      {/* Structured data. Only claims this page itself makes — see src/lib/seo.ts. */}
      <script
        type="application/ld+json"
        // The payload is built from our own constants, never from user input.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(productJsonLd()) }}
      />

      {/* ── Hero ─────────────────────────────────────────────────────────
          A dawn sky, painted in CSS rather than photographed: no asset to
          ship, no licence to track, and it scales to any viewport without
          ever being the wrong crop. The hero commits to one visual world in
          both themes - the sky is the sky - while the page below follows the
          reader's theme as usual. */}
      <section className="relative isolate min-h-[100svh] overflow-hidden">
        {/* Sky */}
        <div
          aria-hidden
          className="absolute inset-0 -z-30"
          style={{
            background:
              'linear-gradient(180deg,' +
              '#0b1030 0%,' +
              '#1b2a5e 22%,' +
              '#3f4a8f 42%,' +
              '#7a6aa0 58%,' +
              '#b57f9c 71%,' +
              '#e0a08f 82%,' +
              '#f2c79c 92%,' +
              '#f7dcb4 100%)',
          }}
        />

        {/* Stars, only where the sky is dark enough to hold them. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 -z-30 h-[46%] opacity-70"
          style={{
            backgroundImage:
              'radial-gradient(1.4px 1.4px at 12% 18%, rgba(255,255,255,.9), transparent 60%),' +
              'radial-gradient(1.2px 1.2px at 28% 8%, rgba(255,255,255,.7), transparent 60%),' +
              'radial-gradient(1.6px 1.6px at 44% 26%, rgba(255,255,255,.85), transparent 60%),' +
              'radial-gradient(1px 1px at 61% 12%, rgba(255,255,255,.6), transparent 60%),' +
              'radial-gradient(1.5px 1.5px at 73% 30%, rgba(255,255,255,.8), transparent 60%),' +
              'radial-gradient(1.1px 1.1px at 86% 16%, rgba(255,255,255,.65), transparent 60%),' +
              'radial-gradient(1.3px 1.3px at 93% 36%, rgba(255,255,255,.7), transparent 60%),' +
              'radial-gradient(1px 1px at 6% 40%, rgba(255,255,255,.5), transparent 60%)',
            maskImage: 'linear-gradient(180deg, #000 0%, #000 55%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(180deg, #000 0%, #000 55%, transparent 100%)',
          }}
        />

        {/* The sun, just under the horizon line. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 -z-30 h-[55%]"
          style={{
            background:
              'radial-gradient(60% 70% at 50% 100%, rgba(255,214,164,.75) 0%, rgba(255,190,150,.28) 38%, transparent 72%)',
          }}
        />

        {/* Cloud banks: wide, soft ellipses rather than a texture, so they
            stay crisp at any resolution and cost nothing to load. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 -z-20 h-[62%]"
          style={{
            background:
              // Wide, flat ellipses read as a sea of cloud; tall ones read as
              // fog. The flattening is what makes this look like altitude.
              'radial-gradient(46% 11% at 20% 84%, rgba(255,241,228,.82) 0%, transparent 70%),' +
              'radial-gradient(38% 9% at 74% 79%, rgba(255,230,224,.72) 0%, transparent 72%),' +
              'radial-gradient(60% 13% at 50% 93%, rgba(255,243,226,.88) 0%, transparent 68%),' +
              'radial-gradient(30% 7% at 38% 71%, rgba(246,226,238,.60) 0%, transparent 74%),' +
              'radial-gradient(26% 6% at 88% 66%, rgba(236,220,246,.48) 0%, transparent 76%),' +
              'radial-gradient(34% 8% at 8% 74%, rgba(248,228,236,.52) 0%, transparent 74%),' +
              'radial-gradient(80% 16% at 50% 100%, rgba(255,246,232,.9) 0%, transparent 72%)',
            filter: 'blur(6px)',
          }}
        />

        {/* A scrim under the copy. Without it the headline sits on the
            brightest part of the sky and the contrast collapses. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(70% 50% at 50% 38%, rgba(8,10,28,.42) 0%, transparent 72%)',
          }}
        />

        {/* ── Nav ──────────────────────────────────────────────────────── */}
        <header className="relative z-10">
          <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6 sm:px-8">
            <Link href="/" className="flex items-center gap-2.5" aria-label="Figbolt home">
              <LogoTile className="size-8 ring-1 ring-white/20" />
              <span
                className="text-xl text-white"
                style={{ fontFamily: 'var(--font-display), Georgia, serif' }}
              >
                Figbolt
              </span>
            </Link>

            <div className="hidden items-center gap-8 md:flex">
              <a href="#small-teams" className="text-sm text-white/80 transition-colors hover:text-white">
                For small businesses
              </a>
              <a href="#how" className="text-sm text-white/80 transition-colors hover:text-white">
                How it works
              </a>
              <Link href="/why" className="text-sm text-white/80 transition-colors hover:text-white">
                vs Salesforce
              </Link>
              <a href="#agents" className="text-sm text-white/80 transition-colors hover:text-white">
                For agents
              </a>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              {!signedIn && (
                <Link
                  href="/login"
                  className="hidden px-2 py-2 text-sm text-white/80 transition-colors hover:text-white sm:block"
                >
                  Sign in
                </Link>
              )}
              <Link
                href={signedIn ? '/home' : '/signup'}
                className="rounded-full border border-white/35 bg-white/10 px-5 py-2.5 text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                {signedIn ? 'Go to dashboard' : 'Begin free'}
              </Link>
            </div>
          </nav>
        </header>

        {/* ── Statement ────────────────────────────────────────────────── */}
        <div className="relative z-10 mx-auto flex min-h-[calc(100svh-5.5rem)] max-w-5xl flex-col items-center justify-center px-5 pb-24 text-center sm:px-8">
          {/* The page's main heading is what it is — the AI-native CRM for small
              businesses — because that is what search engines read as the
              page's subject. The display line below is the same visual design,
              set as a paragraph. */}
          <h1 className="mb-7 rounded-full border border-white/30 bg-white/10 px-4 py-1.5 text-xs font-medium tracking-wide text-white/90 text-balance backdrop-blur-sm">
            The AI-native CRM for Solopreneurs &amp; Small Businesses
          </h1>
          <p
            className="max-w-4xl text-[clamp(2.6rem,7.4vw,5.5rem)] leading-[1.03] tracking-[-0.015em] text-white text-balance"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
          >
            The CRM keeps itself.
          </p>

          <p className="mt-7 max-w-2xl text-[15px] leading-relaxed text-white/85 text-pretty sm:text-lg">
            For solopreneurs and teams up to ten who have customers to look after, not a database to feed.
            Connect your email, calendar and pocket recorder, and Figbolt fills in your
            customers, deals and follow-ups itself. AI voice agents make the follow-up calls,
            and you approve anything that reaches a customer.
          </p>

          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:gap-3">
            <Link
              href={signedIn ? '/home' : '/signup'}
              className="rounded-full border border-white/40 bg-white/15 px-9 py-3.5 text-[15px] font-medium text-white shadow-[0_8px_32px_-12px_rgba(0,0,0,.6)] backdrop-blur-md transition-all hover:bg-white/25 hover:shadow-[0_10px_40px_-12px_rgba(0,0,0,.7)]"
            >
              {signedIn ? 'Go to dashboard' : 'Begin free'}
            </Link>
            <Link
              href="/login"
              className="rounded-full px-6 py-3.5 text-[15px] text-white/80 transition-colors hover:text-white"
            >
              See the live demo
            </Link>
          </div>

          {/* On a phone this line lands on the brightest band of cloud, so it
              gets more opacity and a soft shadow rather than a faint white. */}
          <p className="mt-8 text-xs text-white/80 [text-shadow:0_1px_8px_rgba(8,10,28,0.5)]">
            No credit card. No data entry. The demo workspace is fictional.
          </p>
        </div>

        {/* The horizon, where the sky hands over to the page. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-10 h-28"
          style={{ background: 'linear-gradient(180deg, transparent, var(--bg))' }}
        />
      </section>

      {/* ── Minimal work ─────────────────────────────────────────────────────
          Who it is for, in terms of the hours it gives back. Every line on the
          right is something the product actually does today. */}
      <section id="small-teams" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="max-w-2xl text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
            When it&rsquo;s just you, or a few of you, no one keeps the CRM up to date
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-muted text-pretty">
            Whether you work alone or with a handful of people, the person who would update the CRM is the same person
            talking to the customer. So the CRM goes stale, and it stops being worth opening.
            Figbolt does that upkeep for you.
          </p>

          <div className="mt-9 grid overflow-hidden rounded-[var(--radius-lg)] border border-border-strong bg-surface md:grid-cols-2">
            <div className="p-6 sm:p-7">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-text-subtle">
                Your job, in a typical CRM
              </p>
              <ul className="mt-5 space-y-3.5">
                {[
                  'Log every call and email by hand',
                  'Move each deal to the right stage',
                  'Remember what you promised, and when',
                  'Write up notes after every meeting',
                  'Type up what was said in person, from memory',
                  'Make every follow-up call yourself',
                  'Build a report to see what needs attention',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 text-sm leading-snug text-text-muted">
                    <span aria-hidden className="mt-1.5 text-text-subtle">
                      —
                    </span>
                    <span className="text-pretty line-through decoration-text-subtle/60">{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-t border-border bg-bg-muted p-6 sm:p-7 md:border-l md:border-t-0">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-accent-text">
                Figbolt&rsquo;s job instead
              </p>
              <ul className="mt-5 space-y-3.5">
                {[
                  'Reads your email and meetings and files them against the right customer',
                  'Flags deals that are slipping, and shows you why',
                  'Turns promises in emails and calls into follow-ups with due dates',
                  'Summarises every meeting from its transcript',
                  'Turns in-person conversations from pocket AI recorders like Pocket, Plaud and Omi into notes',
                  'Sends AI voice agents to make the follow-up calls you approve',
                  'Briefs you each morning on what changed and what needs you',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 text-sm leading-snug text-text">
                    <span aria-hidden className="mt-1.5 text-accent-text">
                      —
                    </span>
                    <span className="text-pretty">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              {
                k: 'Connect once',
                d: 'Link Gmail, Google Calendar and a pocket AI recorder such as Pocket or Omi. Your customers and deals appear from the conversations you have already had.',
              },
              {
                k: 'Approve, don’t type',
                d: 'When Figbolt wants to change a deal, email a customer or have a voice agent call them, you get one tap to approve. Nothing goes out without you.',
              },
              {
                k: 'Just ask',
                d: '“Who haven’t I followed up with?” Ask Bolt in plain English and get an answer that shows its sources.',
              },
            ].map((x) => (
              <div key={x.k} className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
                <p className="text-sm font-semibold tracking-tight text-text">{x.k}</p>
                <p className="mt-2 text-xs leading-relaxed text-text-muted text-pretty">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── The gap ──────────────────────────────────────────────────────── */}
      <section className="border-b border-border bg-bg-subtle">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="max-w-2xl text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
            The fields are all filled in. They still tell you nothing.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-muted text-pretty">
            A perfect-looking record, next to what the same company&rsquo;s own email, transcripts,
            tickets and telemetry actually say about it.
          </p>

          <div className="mt-9 grid overflow-hidden rounded-[var(--radius-lg)] border border-border-strong bg-surface md:grid-cols-2">
            <div className="p-6 sm:p-7">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-text-subtle">
                What the CRM says
              </p>
              <dl className="mt-5 space-y-3.5">
                {[
                  ['Stage', 'Negotiation'],
                  ['Amount', '$24,000'],
                  ['Close date', '29 September'],
                  ['Next step', '“Following up this week”'],
                  ['Forecast', 'Commit'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline gap-4">
                    <dt className="w-24 shrink-0 text-xs text-text-subtle">{k}</dt>
                    <dd className="text-sm font-medium text-text">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="border-t border-border bg-bg-muted p-6 sm:p-7 md:border-l md:border-t-0">
              <p className="text-2xs font-medium uppercase tracking-[0.14em] text-accent-text">
                What the sources say
              </p>
              <ul className="mt-5 space-y-3.5">
                {[
                  '39 days in the same stage, unchanged',
                  'Champion’s last reply: 17 days ago',
                  'Daily active users: 7 → 0 since May',
                  'Open urgent ticket: “I cannot justify it at renewal”',
                  'Security review raised in March, still unresolved',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 text-sm leading-snug text-text">
                    <span aria-hidden className="mt-1.5 text-accent-text">
                      —
                    </span>
                    <span className="text-pretty">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-6 max-w-3xl text-sm leading-relaxed text-text-muted text-pretty">
            Nothing on the left is wrong. It is just the wrong artefact — a summary written after
            the fact by the busiest person on the deal, about a relationship whose real state is
            sitting unread in four other systems.
          </p>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="max-w-2xl text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
            AI-native from the first record, not AI bolted on
          </h2>

          <div className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-border bg-border md:grid-cols-3">
            {[
              {
                tag: 'Memory',
                title: 'The record derives itself',
                body: 'Email, calendar, transcripts, support tickets and usage rollups come in. Facts, commitments, concerns, requests and buying roles come out — each keeping a pointer to the sentence it came from.',
              },
              {
                tag: 'Agents',
                title: 'Work happens on top of it',
                body: 'Typed tools over that memory. Agents are configured in plain English, run step by step where you can watch, and brief you every morning on what actually changed.',
              },
              {
                tag: 'Control',
                title: 'You hold the consequential half',
                body: 'Every action is classed low, medium or high risk. Anything that leaves the building stops for a named human who sees the exact payload, and the decision is written to an append-only log.',
              },
            ].map((c) => (
              <div key={c.tag} className="bg-surface p-6 sm:p-7">
                <p className="text-2xs font-medium uppercase tracking-[0.14em] text-accent-text">
                  {c.tag}
                </p>
                <h3 className="mt-3 text-base font-semibold tracking-tight text-text">{c.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-text-muted text-pretty">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Scores you can argue with ────────────────────────────────────── */}
      <section className="border-b border-border bg-bg-subtle">
        <div className="mx-auto grid max-w-6xl items-start gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div>
            <h2 className="max-w-xl text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
              A score you can argue with
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-text-muted text-pretty">
              Health is arithmetic, not a vibe from a model. Every factor carries a signed weight
              and the record that triggered it, and related factors decay by rank so six symptoms
              of one problem don&rsquo;t bury a decent deal. Figbolt narrates the number; it never
              invents it.
            </p>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-text-muted text-pretty">
              This account looks healthy in every conversation. Its emails are warm. What gives it
              away is that the product stopped being opened — and a ticket said the quiet part out
              loud.
            </p>
          </div>

          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border-strong bg-surface shadow-[var(--shadow-md)]">
            <div className="flex items-baseline justify-between gap-3 border-b border-border px-5 py-4">
              <span className="text-sm font-semibold text-text">Solstice Energy</span>
              <span className="flex items-baseline gap-2">
                <span className="rounded-[var(--radius-sm)] bg-danger-subtle px-2 py-0.5 text-3xs font-medium uppercase tracking-wider text-danger-text">
                  At risk
                </span>
                <span className="text-2xl font-semibold tabular text-danger-text">26</span>
                <span className="text-xs text-text-subtle">/100</span>
              </span>
            </div>

            <div className="px-5 py-4">
              <p className="text-3xs font-medium uppercase tracking-[0.14em] text-success-text">
                Working in your favour
              </p>
              <ul className="mt-2.5 space-y-2">
                <Factor w="+8" label="Two-way conversation" detail="They reply as often as we write" />
                <Factor w="+6" label="1 open opportunity" detail="$41,000 in play" />
              </ul>
            </div>

            <div className="border-t border-border px-5 py-4">
              <p className="text-3xs font-medium uppercase tracking-[0.14em] text-danger-text">
                Risks
              </p>
              <ul className="mt-2.5 space-y-2">
                <Factor
                  w="−22"
                  down
                  label="Product usage has gone dormant"
                  detail="Averaged 7 daily active users last month, effectively zero now"
                />
                <Factor w="−8" down label="2 open concerns" detail="Security review unresolved" />
                <Factor w="−5" down label="Quiet for 17 days" />
                <Factor w="−3" down label="1 urgent support ticket" />
              </ul>
            </div>

            <p className="border-t border-border bg-bg-muted px-5 py-3 font-mono text-2xs tabular text-text-subtle">
              Base 50 + 14 positive − 38 risk = 26
            </p>
          </div>
        </div>
      </section>

      {/* ── For agents ───────────────────────────────────────────────────── */}
      <section id="agents" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="max-w-2xl text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
            Built for agents, not just for browsers
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-muted text-pretty">
            The same permissions, the same risk gates and the same audit log, whichever way you come
            in. A high-risk write returns &ldquo;queued for approval&rdquo; — never a quiet success.
          </p>

          <div className="mt-9 grid gap-4 sm:grid-cols-3">
            {[
              { k: 'REST', v: 'GET /api/v1', d: 'Self-documenting. Reads and writes every record.' },
              { k: 'MCP', v: 'POST /api/mcp', d: 'Model Context Protocol, so another agent can use Figbolt as a tool server.' },
              { k: 'CLI', v: 'figbolt ask "…"', d: 'Ask your customers a question from a terminal or a cron job.' },
            ].map((x) => (
              <div
                key={x.k}
                className="rounded-[var(--radius-lg)] border border-border bg-surface p-5"
              >
                <p className="text-2xs font-medium uppercase tracking-[0.14em] text-accent-text">
                  {x.k}
                </p>
                <p className="mt-2.5 font-mono text-sm text-text">{x.v}</p>
                <p className="mt-2 text-xs leading-relaxed text-text-muted text-pretty">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────────
          Mirrored in the FAQPage structured data from the same list. */}
      <section id="faq" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
            Questions about an AI-native CRM
          </h2>
          <dl className="mt-8 divide-y divide-border border-y border-border">
            {HOME_FAQS.map((faq) => (
              <div key={faq.q} className="py-5">
                <dt className="text-[15px] font-semibold text-text">{faq.q}</dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-text-muted text-pretty">{faq.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 text-sm text-text-muted">
            More in{' '}
            <Link href="/ai-crm" className="text-accent-text hover:underline">
              what an AI-native CRM is
            </Link>
            ,{' '}
            <Link href="/crm-for-small-business" className="text-accent-text hover:underline">
              Figbolt for small businesses
            </Link>{' '}
            and{' '}
            <Link href="/crm-for-solopreneurs" className="text-accent-text hover:underline">
              Figbolt for solopreneurs
            </Link>
            .
          </p>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="border-b border-border bg-bg-subtle">
        <div className="mx-auto max-w-6xl px-5 py-16 text-center sm:px-8 sm:py-20">
          <h2 className="mx-auto max-w-2xl text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-text text-balance sm:text-[2.35rem]"
            style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}>
            Stop maintaining your CRM. Start reading it.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-text-muted text-pretty">
            Sign in to the demo workspace and open any account. Every summary, follow-up and score
            in it came from email and meeting transcripts — nobody typed any of it in.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={signedIn ? '/home' : '/login'}
              className="rounded-[var(--radius-md)] bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-md)] transition-colors hover:bg-accent-hover"
            >
              {signedIn ? 'Go to dashboard' : 'Explore the demo'}
            </Link>
            <Link
              href="/signup"
              className="rounded-[var(--radius-md)] border border-border-strong bg-surface px-5 py-2.5 text-sm font-medium text-text transition-colors hover:bg-surface-hover"
            >
              Create a workspace
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <nav aria-label="Learn more" className="mb-6 flex flex-wrap gap-x-6 gap-y-2">
          {MARKETING_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-6 items-center text-xs text-text-muted transition-colors hover:text-accent-text"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Brand />
          <p className="text-2xs text-text-subtle">
            Sweet deals, lightning fast. &middot; The AI-native CRM for small businesses and solopreneurs. &middot; Demo data is fictional.
          </p>
        </div>
      </footer>
    </main>
  );
}

function Factor({
  w,
  label,
  detail,
  down = false,
}: {
  w: string;
  label: string;
  detail?: string;
  down?: boolean;
}) {
  return (
    <li className="flex items-baseline gap-3">
      <span
        className={`w-8 shrink-0 text-right font-mono text-xs font-semibold tabular ${
          down ? 'text-danger-text' : 'text-success-text'
        }`}
      >
        {w}
      </span>
      <span className="min-w-0">
        <span className="text-xs font-medium text-text">{label}</span>
        {detail && (
          <span className="block text-2xs leading-snug text-text-subtle text-pretty">{detail}</span>
        )}
      </span>
    </li>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoTile className="size-8" />
      <span className="text-base font-semibold tracking-tight text-text">Figbolt</span>
    </div>
  );
}

