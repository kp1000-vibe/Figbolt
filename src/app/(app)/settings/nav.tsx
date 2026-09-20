'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Role } from '@/db/schema';
import { can, type Permission } from '@/lib/security/permissions';
import { cn } from '@/lib/utils';

const SECTIONS: { href: string; label: string; permission?: Permission }[] = [
  { href: '/settings', label: 'Workspace' },
  { href: '/settings/team', label: 'Team', permission: 'member:manage' },
  { href: '/settings/ai', label: 'AI & agents', permission: 'security:manage' },
  { href: '/settings/security', label: 'Security & audit', permission: 'audit:read' },
];

export function SettingsNav({ role }: { role: Role }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="min-w-0">
      <ul className="space-y-0.5">
        {SECTIONS.filter((s) => !s.permission || can(role, s.permission)).map((section) => {
          const active = pathname === section.href;
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded-[var(--radius-md)] px-2 py-1.5 text-xs transition-colors',
                  active
                    ? 'bg-surface font-medium text-text shadow-[var(--shadow-sm)]'
                    : 'text-text-muted hover:bg-bg-muted hover:text-text',
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 px-1 text-[10px] leading-relaxed text-text-subtle text-pretty">
        Sections you cannot access are hidden here and enforced on the server, not just in this menu.
      </p>
    </nav>
  );
}
