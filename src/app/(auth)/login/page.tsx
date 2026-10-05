import { redirect } from 'next/navigation';
import Link from 'next/link';
import { safeNext } from '@/lib/auth/safe-next';
import { getCurrentUser, listUserWorkspaces } from '@/lib/auth/session';
import { LoginForm } from './login-form';
import { demoCredentials } from './actions';
import { LogoTile } from '@/components/brand/logo';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const params = await searchParams;

  // Already signed in with a workspace? Skip the form.
  const user = await getCurrentUser();
  if (user) {
    const workspaces = await listUserWorkspaces(user.id);
    // Through safeNext: an unchecked `next` here was an open redirect.
    if (workspaces.length > 0) redirect(safeNext(params.next));
    redirect('/onboarding');
  }

  const demo = await demoCredentials();

  return (
    <main className="relative grid min-h-dvh lg:grid-cols-[1fr_minmax(420px,42%)]">
      {/* ── Narrative panel ────────────────────────────────────────────── */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-bg-subtle p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.55]"
          style={{
            background:
              'radial-gradient(60% 50% at 15% 10%, var(--accent-subtle) 0%, transparent 70%), radial-gradient(50% 40% at 85% 85%, var(--info-subtle) 0%, transparent 70%)',
          }}
        />

        <div className="relative">
          <Mark />
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-3xl font-semibold tracking-tight text-text text-balance">
            The AI-native CRM that already knows what happened.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-text-muted text-pretty">
            Figbolt reads your emails, meetings and calls, turns them into structured customer
            knowledge, and keeps a living model of every relationship. Agents work on top of that
            memory — and stop for you before anything leaves the building.
          </p>

          <dl className="mt-9 space-y-5">
            {[
              {
                term: 'Nothing is manually maintained',
                detail:
                  'Commitments, objections, budgets and buying roles are extracted from conversations, each keeping the sentence it came from.',
              },
              {
                term: 'Every claim is traceable',
                detail:
                  'Answers cite the email or transcript behind them. When the evidence is thin, Bolt says so instead of guessing.',
              },
              {
                term: 'Humans hold the consequential actions',
                detail:
                  'Agents research and propose freely. Sending, deleting and bulk edits wait for an approval that shows the exact payload.',
              },
            ].map((item) => (
              <div key={item.term} className="flex gap-3">
                <CheckIcon />
                <div>
                  <dt className="text-sm font-medium text-text">{item.term}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-text-muted text-pretty">
                    {item.detail}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-2xs text-text-subtle">
          Figbolt · a demonstration build. Customer data shown in the demo workspace is fictional.
        </p>
      </section>

      {/* ── Form panel ─────────────────────────────────────────────────── */}
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="lg:hidden">
            <Mark />
          </div>

          <h2 className="mt-8 text-xl font-semibold tracking-tight text-text lg:mt-0">
            Sign in to Figbolt
          </h2>
          <p className="mt-1.5 text-sm text-text-muted">
            New here?{' '}
            <Link href="/signup" className="font-medium text-accent-text hover:underline">
              Create a workspace
            </Link>
          </p>

          {params.reason === 'session_expired' && (
            <p className="mt-5 rounded-[var(--radius-md)] border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning-text">
              Your session expired. Sign in again to continue.
            </p>
          )}

          <LoginForm next={params.next} demo={demo} />
        </div>
      </section>
    </main>
  );
}

function Mark() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoTile className="size-8" />
      <span className="text-base font-semibold tracking-tight text-text">Figbolt</span>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="mt-0.5 size-4 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
