import { env } from '@/lib/env';

/**
 * Who may see platform-level pages such as website analytics. This is the
 * operator of figbolt.com, not a workspace role: no workspace owner can see
 * another product's traffic. Unset means nobody.
 */
export function isSiteAdmin(email: string | null | undefined): boolean {
  if (!email || !env.SITE_ADMIN_EMAILS) return false;
  const allowed = env.SITE_ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}
