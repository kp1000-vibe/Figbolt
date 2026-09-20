import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="font-mono text-xs tracking-wide text-text-subtle uppercase">404</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-text">Nothing here</h1>
      <p className="mt-1.5 max-w-sm text-sm text-text-muted text-pretty">
        That page does not exist, or the record was deleted.
      </p>
      <Link
        href="/home"
        className="mt-6 inline-flex h-9 items-center rounded-[var(--radius-md)] border border-border bg-surface px-3.5 text-sm font-medium text-text shadow-[var(--shadow-sm)] hover:bg-surface-hover"
      >
        Back to Home
      </Link>
    </main>
  );
}
