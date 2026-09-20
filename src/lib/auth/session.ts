import { cookies, headers } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { sessions, users, workspaceMembers, workspaces } from '@/db/schema';
import type { Role } from '@/db/schema';
import { authSecret, env } from '@/lib/env';
import { hashIp, randomToken, sha256 } from '@/lib/security/crypto';
import { permissionsFor, type Permission } from '@/lib/security/permissions';

export const SESSION_COOKIE = 'nexus_session';
export const WORKSPACE_COOKIE = 'nexus_workspace';
const SESSION_TTL_DAYS = 30;

/**
 * Session strategy: a signed JWT in an httpOnly cookie *plus* a server-side
 * `sessions` row. The JWT keeps the common path free of a database read for
 * identity; the row makes revocation immediate (sign-out everywhere, member
 * removal) instead of waiting for token expiry.
 */

type SessionClaims = { sub: string; sid: string };

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  title: string | null;
};

export type WorkspaceContext = {
  user: AuthenticatedUser;
  sessionId: string;
  workspace: {
    id: string;
    name: string;
    slug: string;
    isDemo: boolean;
    onboardingCompletedAt: Date | null;
    onboardingStep: string;
  };
  role: Role;
  permissions: readonly Permission[];
};

async function signSessionToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('nexus-crm')
    .setAudience('nexus-app')
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(authSecret());
}

async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret(), {
      issuer: 'nexus-crm',
      audience: 'nexus-app',
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

/** Issue a session: writes the revocable row, then sets the cookie. */
export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const hdrs = await headers();
  const raw = randomToken(32);

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256(raw),
      userAgent: hdrs.get('user-agent')?.slice(0, 512) ?? null,
      ipHash: hashIp(hdrs.get('x-forwarded-for')?.split(',')[0]?.trim()),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000),
    })
    .returning({ id: sessions.id });

  if (!row) throw new Error('Failed to create session.');

  const token = await signSessionToken(userId, row.id);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, `${token}.${raw}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.AUTH_COOKIE_SECURE,
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;
  if (cookie) {
    const claims = await readCookieClaims(cookie);
    if (claims) {
      const db = await getDb();
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, claims.sid));
    }
  }
  jar.delete(SESSION_COOKIE);
  jar.delete(WORKSPACE_COOKIE);
}

async function readCookieClaims(
  cookie: string,
): Promise<(SessionClaims & { raw: string }) | null> {
  // The cookie is `<jwt>.<opaque-token>`; the JWT itself contains two dots.
  const lastDot = cookie.lastIndexOf('.');
  if (lastDot === -1) return null;
  const token = cookie.slice(0, lastDot);
  const raw = cookie.slice(lastDot + 1);
  const claims = await verifySessionToken(token);
  return claims ? { ...claims, raw } : null;
}

/** Resolve the current user, or null. Never throws for anonymous visitors. */
export async function getCurrentUser(): Promise<
  (AuthenticatedUser & { sessionId: string }) | null
> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE)?.value;
  if (!cookie) return null;

  const claims = await readCookieClaims(cookie);
  if (!claims) return null;

  const db = await getDb();
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      title: users.title,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      tokenHash: sessions.tokenHash,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, claims.sid), isNull(users.deletedAt)))
    .limit(1);

  if (!row) return null;
  // Bind the JWT to the server-side row: a forged or replayed token whose
  // opaque half doesn't match is rejected even if the signature verifies.
  if (row.tokenHash !== sha256(claims.raw)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    title: row.title,
    sessionId: claims.sid,
  };
}

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('Not signed in.');
    this.name = 'UnauthenticatedError';
  }
}

export class NoWorkspaceError extends Error {
  readonly code = 'NO_WORKSPACE';
  constructor() {
    super('No accessible workspace.');
    this.name = 'NoWorkspaceError';
  }
}

export async function requireUser(): Promise<AuthenticatedUser & { sessionId: string }> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/** List every workspace the current user can enter. */
export async function listUserWorkspaces(userId: string) {
  const db = await getDb();
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      logoUrl: workspaces.logoUrl,
      isDemo: workspaces.isDemo,
      role: workspaceMembers.role,
      onboardingCompletedAt: workspaces.onboardingCompletedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, 'active'),
        isNull(workspaces.deletedAt),
      ),
    );
}

/**
 * The single entry point every authenticated server surface uses.
 *
 * Membership is re-read on each request rather than trusted from the token, so
 * a role change or removal takes effect on the very next action.
 */
export async function requireWorkspace(preferredWorkspaceId?: string): Promise<WorkspaceContext> {
  const user = await requireUser();
  const jar = await cookies();
  const cookieWorkspace = jar.get(WORKSPACE_COOKIE)?.value;
  const db = await getDb();

  const memberships = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      name: workspaces.name,
      slug: workspaces.slug,
      isDemo: workspaces.isDemo,
      onboardingCompletedAt: workspaces.onboardingCompletedAt,
      onboardingStep: workspaces.onboardingStep,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, user.id),
        eq(workspaceMembers.status, 'active'),
        isNull(workspaces.deletedAt),
      ),
    );

  if (memberships.length === 0) throw new NoWorkspaceError();

  const wanted = preferredWorkspaceId ?? cookieWorkspace;
  const chosen = memberships.find((m) => m.workspaceId === wanted) ?? memberships[0]!;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      title: user.title,
    },
    sessionId: user.sessionId,
    workspace: {
      id: chosen.workspaceId,
      name: chosen.name,
      slug: chosen.slug,
      isDemo: chosen.isDemo,
      onboardingCompletedAt: chosen.onboardingCompletedAt,
      onboardingStep: chosen.onboardingStep,
    },
    role: chosen.role,
    permissions: permissionsFor(chosen.role),
  };
}

export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  const jar = await cookies();
  jar.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.AUTH_COOKIE_SECURE,
    path: '/',
    maxAge: 365 * 86_400,
  });
}
