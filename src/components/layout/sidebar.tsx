'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn, initials } from '@/lib/utils';
import { Badge, Button, Kbd } from '@/components/ui/primitives';
import { NAV, isActive } from './nav';
import { NavIcon, Close, LogOut, Menu, Monitor, Moon, Sun } from './icons';
import { useTheme } from './theme';

export type SidebarUser = {
  name: string;
  email: string;
  title: string | null;
  role: string;
};

export type SidebarWorkspace = {
  id: string;
  name: string;
  isDemo: boolean;
};

export type NavCounts = { inbox: number; approvals: number; tasks: number };

export function Sidebar({
  user,
  workspace,
  workspaces,
  counts,
  onOpenCommandBar,
}: {
  user: SidebarUser;
  workspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
  counts: NavCounts;
  onOpenCommandBar: () => void;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close the drawer on navigation so a tap-through doesn't leave it covering
  // the page it just opened.
  React.useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <>
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-3 backdrop-blur-md lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
        >
          <Menu />
        </Button>
        <Mark />
        <button
          type="button"
          onClick={onOpenCommandBar}
          className="ml-auto flex h-8 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-xs text-text-subtle"
        >
          Ask anything
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'z-50 flex w-60 shrink-0 flex-col border-r border-border bg-bg-subtle',
          'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:transition-transform',
          mobileOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
          'lg:sticky lg:top-0 lg:h-dvh',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-14 items-center justify-between px-3.5">
          <Mark />
          <Button
            variant="ghost"
            size="iconSm"
            className="lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <Close />
          </Button>
        </div>

        <WorkspaceSwitcher workspace={workspace} workspaces={workspaces} />

        <div className="px-2.5 pt-3">
          <button
            type="button"
            onClick={onOpenCommandBar}
            className="group flex w-full items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-2.5 py-1.5 text-left shadow-[var(--shadow-sm)] transition-colors hover:border-border-strong hover:bg-surface-hover"
          >
            <span className="text-accent [&_svg]:size-3.5">
              <NavIcon name="sparkles" className="size-3.5" />
            </span>
            <span className="flex-1 truncate text-xs text-text-subtle">Ask anything…</span>
            <Kbd>⌘K</Kbd>
          </button>
        </div>

        <nav className="mt-3 flex-1 space-y-4 overflow-y-auto px-2.5 pb-4">
          {NAV.map((group, i) => (
            <div key={group.label ?? `group-${i}`}>
              {group.label && (
                <p className="mb-1 px-2 text-2xs font-semibold tracking-wide text-text-subtle uppercase">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isActive(pathname, item);
                  const count = item.badge ? counts[item.badge] : 0;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-surface font-medium text-text shadow-[var(--shadow-sm)]'
                            : 'text-text-muted hover:bg-bg-muted hover:text-text',
                        )}
                      >
                        <NavIcon
                          name={item.icon}
                          className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-text-subtle')}
                        />
                        <span className="flex-1 truncate">{item.label}</span>
                        {count > 0 && (
                          <Badge tone={item.badge === 'approvals' ? 'warning' : 'accent'}>
                            {count > 99 ? '99+' : count}
                          </Badge>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <UserFooter user={user} />
      </aside>
    </>
  );
}

function Mark() {
  return (
    <Link href="/home" className="flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded-[var(--radius-sm)] bg-accent text-white">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
          <path
            d="M13.5 2.5 6 13.2h4.6L9.8 21.5 18 10.4h-4.9z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-tight text-text">Figbolt</span>
    </Link>
  );
}

function WorkspaceSwitcher({
  workspace,
  workspaces,
}: {
  workspace: SidebarWorkspace;
  workspaces: SidebarWorkspace[];
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const canSwitch = workspaces.length > 1;

  return (
    <div ref={ref} className="relative px-2.5">
      <button
        type="button"
        onClick={() => canSwitch && setOpen((v) => !v)}
        disabled={!canSwitch}
        aria-haspopup={canSwitch ? 'menu' : undefined}
        aria-expanded={canSwitch ? open : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors',
          canSwitch && 'hover:bg-bg-muted',
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-xs)] bg-text text-2xs font-bold text-text-inverted">
          {initials(workspace.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text">{workspace.name}</span>
          {workspace.isDemo && <span className="block text-[10px] text-text-subtle">Demo data</span>}
        </span>
        {canSwitch && (
          <svg viewBox="0 0 24 24" className="size-3 text-text-subtle" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
            <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="animate-scale-in absolute top-full left-2.5 right-2.5 z-10 mt-1 origin-top overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface-raised shadow-[var(--shadow-lg)]"
        >
          {workspaces.map((ws) => (
            <form key={ws.id} action={`/api/workspace/switch`} method="post">
              <input type="hidden" name="workspaceId" value={ws.id} />
              <button
                type="submit"
                role="menuitem"
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-hover',
                  ws.id === workspace.id && 'font-medium text-accent-text',
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-[3px] bg-bg-muted text-[9px] font-bold text-text-muted">
                  {initials(ws.name)}
                </span>
                <span className="truncate">{ws.name}</span>
              </button>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}

function UserFooter({ user }: { user: SidebarUser }) {
  const { theme, setTheme } = useTheme();

  const options = [
    { value: 'light' as const, Icon: Sun, label: 'Light' },
    { value: 'dark' as const, Icon: Moon, label: 'Dark' },
    { value: 'system' as const, Icon: Monitor, label: 'System' },
  ];

  return (
    <div className="border-t border-border p-2.5">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-muted text-2xs font-semibold text-text-muted">
          {initials(user.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text">{user.name}</span>
          <span className="block truncate text-[10px] text-text-subtle capitalize">{user.role}</span>
        </span>
        <form action="/api/auth/logout" method="post">
          <Button
            type="submit"
            variant="ghost"
            size="iconSm"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut />
          </Button>
        </form>
      </div>

      <div
        role="radiogroup"
        aria-label="Colour theme"
        className="flex items-center gap-0.5 rounded-[var(--radius-md)] bg-bg-muted p-0.5"
      >
        {options.map(({ value, Icon, label }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'flex flex-1 items-center justify-center rounded-[var(--radius-sm)] py-1 transition-colors',
              theme === value
                ? 'bg-surface text-text shadow-[var(--shadow-sm)]'
                : 'text-text-subtle hover:text-text',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
