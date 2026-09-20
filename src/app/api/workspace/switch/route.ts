import { redirect } from 'next/navigation';
import { switchWorkspace } from '@/app/(auth)/login/actions';

export async function POST(request: Request) {
  const form = await request.formData();
  const workspaceId = form.get('workspaceId');
  if (typeof workspaceId !== 'string') redirect('/home');
  // Membership is re-verified inside switchWorkspace.
  await switchWorkspace(workspaceId);
}
