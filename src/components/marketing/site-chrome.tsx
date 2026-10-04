import Link from 'next/link';
import { LogoTile } from '@/components/brand/logo';
import { SITE } from '@/lib/seo';

/**
 * Header and footer for the public pages.
 *
 * The footer's links are the internal-linking backbone of the marketing site:
 * every public page links to every other, so a crawler that lands anywhere
 * finds the whole set, and each page's anchor text tells search engines what
 * the page it points at is about.
 */

export const MARKETING_LINKS = [
  { href: '/ai-crm', label: 'What is an AI-native CRM?' },
  { href: '/crm-for-small-business', label: 'CRM for small business' },
  { href: '/crm-for-solopreneurs', label: 'CRM for solopreneurs' },
  { href: '/why', label: 'Figbolt vs Salesforce and HubSpot' },
] as const;

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur-md">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Figbolt home">
          <LogoTile className="size-8" />
          <span className="text-base font-semibold tracking-tight text-text">Figbolt</span>
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-3">
          <Link
            href="/"
            className="hidden rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text-muted transition-colors hover:text-text sm:block"
          >
            Overview
          </Link>
          {signedIn ? (
            <Link
              href="/home"
              className="rounded-[var(--radius-md)] bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-[var(--shadow-sm)] transition-colors hover:bg-accent-hover"
            >
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text-muted transition-colors hover:text-text"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-[var(--radius-md)] bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-[var(--shadow-sm)] transition-colors hover:bg-accent-hover"
              >
                Start free
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

export function SiteFooter({ note }: { note?: string }) {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
        <nav aria-label="Learn more" className="flex flex-wrap gap-x-6 gap-y-2">
          {MARKETING_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-6 items-center text-xs text-text-muted transition-colors hover:text-accent-text"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <span className="text-2xs text-text-subtle">
            {SITE.name} — the AI-native CRM for small businesses and solopreneurs.
          </span>
          {note && <span className="text-2xs text-text-subtle">{note}</span>}
        </div>
      </div>
    </footer>
  );
}
