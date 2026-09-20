'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users, workspaceMembers, workspaces } from '@/db/schema';
import {
  createSession,
  destroySession,
  listUserWorkspaces,
  setActiveWorkspace,
} from '@/lib/auth/session';
import { hashIp, hashPassword, verifyPassword } from '@/lib/security/crypto';
import { checkRateLimit } from '@/server/rate-limit';

/**
 * Authentication actions.
 *
 * Two things worth noting:
 *
 *  - Failures return one generic message regardless of cause. Distinguishing
 *    "no such account" from "wrong password" is a free user-enumeration oracle.
 *  - A miss still performs a password verification against a dummy hash, so the
 *    response time does not reveal whether the address exists.
 */

export type AuthState = { error?: string; fieldErrors?: Record<string, string[]> };

const GENERIC_FAILURE = 'That email and password combination is not correct.';

/** Pre-computed so the timing-equalising path costs the same as a real check. */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('nexus-timing-equaliser');
  return dummyHashPromise;
}

/**
 * `FormData.get()` returns `null` for a missing field, and `z.optional()` only
 * accepts `undefined`. Without this bridge an absent hidden input fails the
 * whole parse — and because it has no visible field, nothing renders the error
 * and the form silently does nothing.
 */
const formOptional = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === null || v === '' ? undefined : v));

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  next: formOptional,
});

export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next'),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> };
  }
  const { email, password, next } = parsed.data;

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

  // Two buckets: per-address stops credential stuffing on one account, per-IP
  // stops spraying across many.
  const byEmail = await checkRateLimit(`login:email:${email}`, 8, 15 * 60);
  const byIp = await checkRateLimit(`login:ip:${hashIp(ip) ?? 'unknown'}`, 30, 15 * 60);
  if (!byEmail.allowed || !byIp.allowed) {
    return { error: 'Too many attempts. Wait a few minutes and try again.' };
  }

  const db = await getDb();
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);

  if (!user?.passwordHash) {
    await verifyPassword(password, await dummyHash());
    return { error: GENERIC_FAILURE };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { error: GENERIC_FAILURE };

  await createSession(user.id);

  const memberships = await listUserWorkspaces(user.id);
  if (memberships.length === 0) redirect('/onboarding');
  await setActiveWorkspace(memberships[0]!.id);

  redirect(safeNext(next));
}

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200)
    // Length is the dominant factor; a single character-class requirement
    // mostly pushes people toward predictable substitutions, so only trivially
    // guessable inputs are barred.
    .refine((v) => !/^(?:password|nexus|12345)/i.test(v), 'Choose something less guessable.'),
});

export async function signup(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signupSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> };
  }
  const { name, email, password } = parsed.data;

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const limit = await checkRateLimit(`signup:ip:${hashIp(ip) ?? 'unknown'}`, 5, 60 * 60);
  if (!limit.allowed) return { error: 'Too many sign-up attempts. Try again later.' };

  const db = await getDb();
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    // Don't confirm the address is taken; point at sign-in instead.
    return { error: 'That address cannot be used to create a new workspace. Try signing in.' };
  }

  const [user] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });

  await createSession(user!.id);
  redirect('/onboarding');
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect('/login');
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const { requireUser } = await import('@/lib/auth/session');
  const user = await requireUser();
  const db = await getDb();

  // Never trust a workspace id from the client without re-checking membership.
  const [membership] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, user.id),
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.status, 'active'),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);

  if (!membership) return;
  await setActiveWorkspace(workspaceId);
  redirect('/home');
}

/**
 * Credentials for the seeded demo workspace, surfaced on the sign-in page so
 * the build is explorable without reading the README. Returns null when no demo
 * workspace exists — a real deployment shows nothing here.
 */
export async function demoCredentials(): Promise<{ email: string; password: string } | null> {
  try {
    const db = await getDb();
    const [demo] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.isDemo, true), isNull(workspaces.deletedAt)))
      .limit(1);
    if (!demo) return null;

    const [owner] = await db
      .select({ email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, demo.id), eq(workspaceMembers.role, 'owner')))
      .limit(1);

    return owner ? { email: owner.email, password: 'demo1234' } : null;
  } catch {
    // The database may not be migrated yet; the page must still render.
    return null;
  }
}

/** Only allow same-origin relative redirects. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/home';
  return next;
}
