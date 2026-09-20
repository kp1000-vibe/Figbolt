import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, listUserWorkspaces } from '@/lib/auth/session';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Create a workspace' };

export default async function SignupPage() {
  const user = await getCurrentUser();
  if (user) {
    const workspaces = await listUserWorkspaces(user.id);
    redirect(workspaces.length > 0 ? '/home' : '/onboarding');
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-[var(--radius-md)] bg-accent text-white shadow-[var(--shadow-md)]">
            <svg viewBox="0 0 24 24" className="size-4.5" fill="none" aria-hidden>
              <path
                d="M5 18V6l7 7 7-7v12"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-base font-semibold tracking-tight text-text">Nexus</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight text-text">Create a workspace</h1>
        <p className="mt-1.5 text-sm text-text-muted">
          Already have one?{' '}
          <Link href="/login" className="font-medium text-accent-text hover:underline">
            Sign in
          </Link>
        </p>

        <SignupForm />

        <p className="mt-6 text-2xs leading-relaxed text-text-subtle text-pretty">
          Nexus reads the email and meetings you connect in order to build customer memory. Nothing is
          sent on your behalf without an explicit approval, and the demo deployment cannot send email
          at all.
        </p>
      </div>
    </main>
  );
}
