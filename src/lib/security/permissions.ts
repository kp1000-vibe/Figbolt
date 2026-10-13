import type { Role } from '@/db/schema';

/**
 * Role-based authorization.
 *
 * One table, consulted by HTTP handlers, server actions and agent tools alike.
 * There is deliberately no second code path: an agent calling `update_record`
 * runs the same `can()` check a human clicking Save does, resolved against the
 * user the agent runs as. That is what makes "an agent can never exceed its
 * authorizer" true structurally rather than by convention.
 */

export const PERMISSIONS = [
  // CRM records
  'record:read',
  'record:create',
  'record:update',
  'record:delete',
  'record:bulk_update',
  // Communication
  'email:draft',
  'email:send',
  'meeting:manage',
  /** Have a voice agent phone a customer. Always approval-gated for agents. */
  'call:place',
  // AI surfaces
  'ai:ask',
  'ai:run_agent',
  'ai:approve_low',
  'ai:approve_medium',
  'ai:approve_high',
  // Configuration
  'agent:manage',
  'automation:manage',
  'knowledge:manage',
  'integration:manage',
  'pipeline:manage',
  'custom_field:manage',
  // Administration
  'workspace:manage',
  'member:manage',
  'billing:manage',
  'audit:read',
  'security:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ['record:read', 'ai:ask'];

const MEMBER: Permission[] = [
  ...VIEWER,
  'record:create',
  'record:update',
  'email:draft',
  'email:send',
  'meeting:manage',
  'call:place',
  'ai:run_agent',
  'ai:approve_low',
  'ai:approve_medium',
];

const MANAGER: Permission[] = [
  ...MEMBER,
  'record:delete',
  'record:bulk_update',
  'ai:approve_high',
  'agent:manage',
  'automation:manage',
  'knowledge:manage',
  'pipeline:manage',
];

const ADMIN: Permission[] = [
  ...MANAGER,
  'custom_field:manage',
  'integration:manage',
  'member:manage',
  'workspace:manage',
  'audit:read',
  'security:manage',
];

const OWNER: Permission[] = [...ADMIN, 'billing:manage'];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  member: MEMBER,
  manager: MANAGER,
  admin: ADMIN,
  owner: OWNER,
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? VIEWER;
}

export function can(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

export function canAll(role: Role, permissions: Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * An agent's effective role is the *lower* of its configured ceiling and the
 * live role of the user it runs as. If that user is demoted or removed, every
 * future run is constrained immediately without touching the agent config.
 */
export function effectiveAgentRole(agentMaxRole: Role, runAsUserRole: Role | null): Role | null {
  if (!runAsUserRole) return null;
  return ROLE_RANK[agentMaxRole] <= ROLE_RANK[runAsUserRole] ? agentMaxRole : runAsUserRole;
}

export class AuthorizationError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(
    readonly permission: Permission,
    readonly role: Role,
    message?: string,
  ) {
    super(message ?? `Role "${role}" is missing the "${permission}" permission.`);
    this.name = 'AuthorizationError';
  }
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new AuthorizationError(permission, role);
}
