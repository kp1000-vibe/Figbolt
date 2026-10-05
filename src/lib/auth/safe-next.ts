/**
 * Where to send someone after sign-in: a path on this site, or /home.
 *
 * Anything that could leave the site is refused: an absolute URL, a
 * protocol-relative `//host`, and `/\host`, which browsers also read as
 * protocol-relative. Without this, /login?next=https://evil.example is an
 * open redirect: a trusted figbolt.com link that lands on a phishing page.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/')) return '/home';
  if (next.startsWith('//') || next.includes('\\')) return '/home';
  // Control characters (tabs, newlines) are stripped by browsers in URLs and
  // can smuggle a scheme past a prefix check.
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/home';
  return next;
}
