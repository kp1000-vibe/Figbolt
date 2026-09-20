import { redirect } from 'next/navigation';
import { destroySession } from '@/lib/auth/session';

/** POST-only: a GET would let a third-party image tag sign the user out. */
export async function POST() {
  await destroySession();
  redirect('/login');
}
