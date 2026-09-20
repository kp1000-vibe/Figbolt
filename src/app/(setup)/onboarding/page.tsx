import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { workspaces } from '@/db/schema';
import { UnauthenticatedError, listUserWorkspaces, requireUser } from '@/lib/auth/session';
import { OnboardingFlow } from './flow';

export const metadata = { title: 'Set up your workspace' };

/**
 * Onboarding.
 *
 * Lives outside the app shell's completeness gate, because the shell redirects
 * here when onboarding is unfinished — rendering it inside would loop. It
 * resolves the session directly rather than through `requireCtx`.
 */
export default async function OnboardingPage() {
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect('/login');
    throw err;
  }

  const memberships = await listUserWorkspaces(user.id);
  const db = await getDb();

  // Already finished? Don't make them do it twice.
  const existing = memberships[0];
  if (existing) {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, existing.id))
      .limit(1);

    if (workspace?.onboardingCompletedAt) redirect('/home');

    return (
      <OnboardingFlow
        userName={user.name}
        existing={
          workspace
            ? {
                id: workspace.id,
                name: workspace.name,
                step: workspace.onboardingStep,
                companyContext: workspace.companyContext ?? {},
              }
            : null
        }
      />
    );
  }

  return <OnboardingFlow userName={user.name} existing={null} />;
}
