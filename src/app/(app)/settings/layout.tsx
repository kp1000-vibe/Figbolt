import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { PageShell } from '@/components/layout/app-shell';
import { SettingsNav } from './nav';

/**
 * Settings shell.
 *
 * The sub-navigation is rendered from a shared list so a new settings page
 * cannot ship without appearing in the rail — which is how sections quietly
 * become unreachable.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();

  return (
    <PageShell>
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-text">Settings</h1>
        <p className="mt-1 text-sm text-text-muted">
          {ctx.session.workspace.name} · you are {article(ctx.session.role)} {ctx.session.role}
        </p>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
        <SettingsNav role={ctx.session.role} />
        <div className="min-w-0">{children}</div>
      </div>
    </PageShell>
  );
}

function article(role: string): string {
  return /^[aeiou]/i.test(role) ? 'an' : 'a';
}
