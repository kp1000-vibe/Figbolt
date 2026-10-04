import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, listUserWorkspaces } from '@/lib/auth/session';
import { SignupForm } from './signup-form';
import { LogoTile } from '@/components/brand/logo';

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
          <LogoTile className="size-8" />
          <span className="text-base font-semibold tracking-tight text-text">Figbolt</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight text-text">Create a workspace</h1>
        <p className="mt-1 text-sm text-text-muted">Your AI-native CRM, filled in from your email and meetings.</p>
        <p className="mt-1.5 text-sm text-text-muted">
          Already have one?{' '}
          <Link href="/login" className="font-medium text-accent-text hover:underline">
            Sign in
          </Link>
        </p>

        <SignupForm />

        <p className="mt-6 text-2xs leading-relaxed text-text-subtle text-pretty">
          Figbolt reads the email and meetings you connect in order to build customer memory. Nothing is
          sent on your behalf without an explicit approval, and the demo deployment cannot send email
          at all.
        </p>
      </div>
    </main>
  );
}
