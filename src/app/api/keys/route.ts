import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { hashIp, verifyPassword } from '@/lib/security/crypto';
import { checkRateLimit } from '@/server/rate-limit';
import { listUserWorkspaces } from '@/lib/auth/session';
import { ROLES, type Role } from '@/db/schema';
import { roleAtLeast } from '@/lib/security/permissions';
import { createApiKey } from '@/server/api/auth';

/**
 * API-key bootstrap.
 *
 * The one endpoint that takes a password, because you cannot mint the first
 * API key with an API key. It is deliberately narrow:
 *
 *  - It only issues keys. It does not create a session or return a cookie, so
 *    a leaked response is a credential the user can revoke from Settings,
 *    not a live login.
 *  - The requested role is clamped to the user's own role, so this is never a
 *    privilege-escalation path.
 *  - It is rate-limited per address and per IP on the same buckets as login,
 *    and failures are deliberately indistinguishable.
 *
 * Used by `npm run cli -- keys:create`. The web app creates keys from
 * Settings → Security, where there is already a session.
 */

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80).default('API key'),
  role: z.enum(ROLES).optional(),
  workspaceId: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const GENERIC_FAILURE = 'Email or password is incorrect.';

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request.', issues: z.flattenError(parsed.error).fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const byEmail = await checkRateLimit(`apikey:email:${input.email}`, 5, 15 * 60);
  const byIp = await checkRateLimit(`apikey:ip:${hashIp(ip) ?? 'unknown'}`, 20, 15 * 60);
  if (!byEmail.allowed || !byIp.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  const db = await getDb();
  const [user] = await db
    .select({ id: users.id, name: users.name, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.email, input.email), isNull(users.deletedAt)))
    .limit(1);

  if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
    return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
  }

  const memberships = await listUserWorkspaces(user.id);
  const workspace = input.workspaceId
    ? memberships.find((m) => m.id === input.workspaceId)
    : memberships[0];

  if (!workspace) {
    return NextResponse.json(
      { error: 'That account is not a member of any workspace yet.' },
      { status: 403 },
    );
  }

  const ctx = {
    db,
    workspaceId: workspace.id,
    userId: user.id,
    role: workspace.role,
    actor: { type: 'user' as const, id: user.id, label: user.name },
  };

  // Clamp rather than reject: asking for more than you have is a mistake worth
  // correcting silently, but it must never be granted.
  const requested: Role = input.role ?? workspace.role;
  const role: Role = roleAtLeast(workspace.role, requested) ? requested : workspace.role;

  const key = await createApiKey(ctx, {
    name: input.name,
    role,
    ...(input.expiresInDays != null ? { expiresInDays: input.expiresInDays } : {}),
  });

  return NextResponse.json(
    {
      id: key.id,
      key: key.plaintext,
      prefix: key.prefix,
      role,
      workspace: { id: workspace.id, name: workspace.name },
      warning: 'This is the only time the key is shown. Store it somewhere safe.',
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}
