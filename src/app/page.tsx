import { redirect } from 'next/navigation';
import { getCurrentUser, listUserWorkspaces } from '@/lib/auth/session';

/** Root: route by session state rather than showing a marketing page. */
export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const workspaces = await listUserWorkspaces(user.id);
  redirect(workspaces.length > 0 ? '/home' : '/onboarding');
}
