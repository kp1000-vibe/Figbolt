import { redirect } from 'next/navigation';
import { NoWorkspaceError, UnauthenticatedError, listUserWorkspaces } from '@/lib/auth/session';
import { requireCtx } from '@/server/context';
import { inboxCounts } from '@/server/inbox';
import { listPendingApprovals } from '@/server/approvals';
import { countOpenTasks } from '@/server/crm/tasks';
import { AppShell } from '@/components/layout/app-shell';

/**
 * The authenticated shell.
 *
 * Session and workspace resolution happen once here rather than in every page,
 * and the badge counters are fetched in parallel with it — a sidebar that
 * blocks on three sequential queries is the difference between the app feeling
 * instant and feeling sluggish on every navigation.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let ctx: Awaited<ReturnType<typeof requireCtx>>;

  try {
    ctx = await requireCtx();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect('/login');
    if (err instanceof NoWorkspaceError) redirect('/onboarding');
    throw err;
  }

  const { session } = ctx;

  // A workspace that never finished onboarding has no pipeline or records yet;
  // sending someone into an empty CRM is worse than finishing setup.
  if (!session.workspace.onboardingCompletedAt) redirect('/onboarding');

  const [counts, approvals, openTasks, workspaces] = await Promise.all([
    inboxCounts(ctx),
    listPendingApprovals(ctx, 100),
    countOpenTasks(ctx, session.user.id),
    listUserWorkspaces(session.user.id),
  ]);

  return (
    <AppShell
      user={{
        name: session.user.name,
        email: session.user.email,
        title: session.user.title,
        role: session.role,
      }}
      workspace={{
        id: session.workspace.id,
        name: session.workspace.name,
        isDemo: session.workspace.isDemo,
      }}
      workspaces={workspaces.map((w) => ({ id: w.id, name: w.name, isDemo: w.isDemo }))}
      counts={{
        inbox: counts['total'] ?? 0,
        approvals: approvals.length,
        tasks: openTasks,
      }}
    >
      {children}
    </AppShell>
  );
}
