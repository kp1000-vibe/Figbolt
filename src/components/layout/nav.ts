/**
 * Navigation model.
 *
 * Ordered by how often the work actually happens, not by data hierarchy:
 * the AI surfaces and the Inbox sit above the record lists because in an
 * agent-native CRM you arrive with a question or a queue, not to browse tables.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Which inbox/approval counter, if any, badges this item. */
  badge?: 'inbox' | 'approvals' | 'tasks';
  /** Also highlight for these path prefixes. */
  match?: string[];
};

export type NavGroup = { label: string | null; items: NavItem[] };

export type IconName =
  | 'home'
  | 'sparkles'
  | 'inbox'
  | 'building'
  | 'users'
  | 'target'
  | 'check'
  | 'calendar'
  | 'bot'
  | 'workflow'
  | 'chart'
  | 'signal'
  | 'radar'
  | 'book'
  | 'plug'
  | 'settings';

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { href: '/home', label: 'Home', icon: 'home' },
      { href: '/ask', label: 'Ask AI', icon: 'sparkles' },
      { href: '/inbox', label: 'Inbox', icon: 'inbox', badge: 'inbox' },
    ],
  },
  {
    label: 'Records',
    items: [
      { href: '/accounts', label: 'Accounts', icon: 'building' },
      { href: '/contacts', label: 'Contacts', icon: 'users' },
      { href: '/opportunities', label: 'Deals', icon: 'target' },
      { href: '/tasks', label: 'Tasks', icon: 'check', badge: 'tasks' },
      { href: '/meetings', label: 'Meetings', icon: 'calendar' },
    ],
  },
  {
    label: 'Automation',
    items: [
      { href: '/agents', label: 'Agents', icon: 'bot', badge: 'approvals' },
      { href: '/automations', label: 'Automations', icon: 'workflow' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { href: '/prospecting', label: 'Prospecting', icon: 'radar' },
      { href: '/analytics', label: 'Analytics', icon: 'chart' },
      { href: '/product-signals', label: 'Product signals', icon: 'signal' },
      { href: '/knowledge', label: 'Knowledge', icon: 'book' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/integrations', label: 'Integrations', icon: 'plug' },
      { href: '/settings', label: 'Settings', icon: 'settings', match: ['/settings'] },
    ],
  },
];

/** Flat list, used by the command palette. */
export const NAV_FLAT: NavItem[] = NAV.flatMap((group) => group.items);

export function isActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  const prefixes = item.match ?? [item.href];
  return prefixes.some((prefix) => pathname.startsWith(`${prefix}/`));
}
