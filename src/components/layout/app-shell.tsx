'use client';

import * as React from 'react';
import { ToastProvider } from '@/components/ui/feedback';
import { CommandBar } from './command-bar';
import { Sidebar, type NavCounts, type SidebarUser, type SidebarWorkspace } from './sidebar';

/**
 * Client shell.
 *
 * Only the parts that genuinely need interactivity live on the client — the
 * sidebar, the command bar and the toast surface. Page content stays a server
 * component and streams into `children`, so navigating between pages does not
 * re-download the shell.
 */
export function AppShell({
  user,
  workspace,
  workspaces,
  counts,
  children,
}: {
  user: SidebarUser;
  workspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
  counts: NavCounts;
  children: React.ReactNode;
}) {
  const [commandOpen, setCommandOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl-K opens from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }

      // Bare "/" is a common shortcut, but must not hijack typing in a field.
      if (e.key === '/' && !commandOpen) {
        const target = e.target as HTMLElement | null;
        const typing =
          target?.tagName === 'INPUT' ||
          target?.tagName === 'TEXTAREA' ||
          target?.isContentEditable === true;
        if (!typing) {
          e.preventDefault();
          setCommandOpen(true);
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commandOpen]);

  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col lg:flex-row">
        <Sidebar
          user={user}
          workspace={workspace}
          workspaces={workspaces}
          counts={counts}
          onOpenCommandBar={() => setCommandOpen(true)}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />
    </ToastProvider>
  );
}

/**
 * Standard page frame. Kept here so every page gets identical gutters and
 * max-width without repeating the classes.
 */
export function PageShell({
  children,
  className,
  wide = false,
}: {
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={[
        'mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        wide ? 'max-w-[1600px]' : 'max-w-7xl',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </div>
  );
}
