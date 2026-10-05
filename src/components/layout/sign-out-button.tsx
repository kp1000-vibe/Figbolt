import { LogOut } from './icons';

/**
 * Sign out, as a plain form POST to /api/auth/logout — the same endpoint the
 * app sidebar uses. A form rather than a link: signing out changes state, and
 * a GET could be triggered by a prefetch or an <img> on another site.
 */
export function SignOutButton({ className = '' }: { className?: string }) {
  return (
    <form action="/api/auth/logout" method="post" className={className}>
      <button
        type="submit"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-sm text-text-muted transition-colors hover:bg-bg-muted hover:text-text"
      >
        <LogOut className="size-4" />
        Sign out
      </button>
    </form>
  );
}
