import { and, eq } from 'drizzle-orm';
import { requireCtx, ctxAssert } from '@/server/context';
import { users, workspaceMembers, ROLES } from '@/db/schema';
import { permissionsFor } from '@/lib/security/permissions';
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { RoleSelect } from './role-select';
import { relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Team' };

export default async function TeamSettingsPage() {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'member:manage');

  const members = await ctx.db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      title: users.title,
      lastLoginAt: users.lastLoginAt,
      role: workspaceMembers.role,
      status: workspaceMembers.status,
      joinedAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId))
    .orderBy(workspaceMembers.role, users.name);

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Team · {members.length}</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              A member&rsquo;s role also caps what their agents can do — changing it takes effect on
              the agent&rsquo;s next run.
            </p>
          </div>
        </CardHeader>
        <CardBody className="px-0 pt-0 pb-0">
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th>Member</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th align="right">Last sign-in</Th>
              </Tr>
            </Thead>
            <Tbody>
              {members.map((member) => (
                <Tr key={member.userId}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={member.name} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">
                          {member.name}
                          {member.userId === ctx.userId && (
                            <span className="ml-1.5 text-2xs text-text-subtle">(you)</span>
                          )}
                        </p>
                        <p className="truncate text-2xs text-text-subtle">
                          {member.title ? `${member.title} · ` : ''}
                          {member.email}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <RoleSelect
                      userId={member.userId}
                      currentRole={member.role}
                      disabled={member.userId === ctx.userId && ctx.session.role === 'owner'}
                    />
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        member.status === 'active'
                          ? 'success'
                          : member.status === 'invited'
                            ? 'info'
                            : 'danger'
                      }
                    >
                      {titleCase(member.status)}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <span className="text-xs text-text-muted">
                      {member.lastLoginAt ? relativeTime(member.lastLoginAt) : 'never'}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>What each role can do</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              Enforced in one table consulted by pages, server actions and agent tools alike.
            </p>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <div className="space-y-3">
            {ROLES.map((role) => {
              const permissions = permissionsFor(role);
              return (
                <div key={role} className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-text">{titleCase(role)}</p>
                    <span className="text-2xs text-text-subtle">
                      {permissions.length} permissions
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {permissions.map((permission) => (
                      <span
                        key={permission}
                        className="rounded-full border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-subtle"
                      >
                        {permission}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inviting people</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          <p className="text-xs leading-relaxed text-text-muted text-pretty">
            Invitations need an outbound email provider. This deployment has{' '}
            <code className="font-mono">EMAIL_PROVIDER=console</code>, which stores messages in the
            outbox and sends nothing — a deliberate default so a demo workspace cannot email real
            people. Set a provider in <code className="font-mono">.env</code> to enable invites.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
