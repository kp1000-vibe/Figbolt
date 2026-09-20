import { ctxAssert, requireCtx } from '@/server/context';
import { listAuditEvents } from '@/server/audit';
import { listApiKeys } from '@/server/api/auth';
import { ApiKeysPanel } from './keys-panel';
import { getDb } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
  Stat,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { Shield } from '@/components/layout/icons';
import { relativeTime, shortDate, titleCase } from '@/lib/utils';

export const metadata = { title: 'Security & audit' };

/**
 * Security posture and the audit trail.
 *
 * The audit log is append-only by construction: `src/server/audit.ts` exposes
 * `record()` and readers, and no update or delete path. That is what makes it
 * usable as evidence of what agents were permitted to do.
 */
export default async function SecuritySettingsPage() {
  const ctx = await requireCtx();
  ctxAssert(ctx, 'audit:read');

  const db = await getDb();

  const [events, activeSessions, counts, apiKeys] = await Promise.all([
    listAuditEvents(ctx, { limit: 100 }),
    db
      .select({
        id: sessions.id,
        userName: users.name,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
      .orderBy(desc(sessions.createdAt))
      .limit(20),
    listAuditEvents(ctx, { limit: 500 }),
    listApiKeys(ctx),
  ]);

  const byRisk = {
    high: counts.filter((e) => e.riskLevel === 'high').length,
    medium: counts.filter((e) => e.riskLevel === 'medium').length,
    agentActions: counts.filter((e) => e.actorType === 'agent').length,
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-4">
          <Stat label="Audit events" value={String(counts.length)} hint="Most recent 500" />
          <Stat label="High-risk actions" value={String(byRisk.high)} tone={byRisk.high > 0 ? 'warning' : 'neutral'} />
          <Stat label="Agent actions" value={String(byRisk.agentActions)} />
          <Stat label="Active sessions" value={String(activeSessions.length)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-2">
            <Shield className="mt-0.5 size-4 shrink-0 text-accent" />
            <div>
              <CardTitle>Security posture</CardTitle>
              <p className="mt-0.5 text-2xs text-text-subtle">How this deployment is configured</p>
            </div>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          <dl>
            <DetailRow label="Tenant isolation">
              Every workspace-owned query goes through a mandatory scope predicate
            </DetailRow>
            <DetailRow label="Passwords">scrypt (N=32768, r=8), per-user salt</DetailRow>
            <DetailRow label="Sessions">
              Signed JWT bound to a revocable server-side row
            </DetailRow>
            <DetailRow label="Integration tokens">AES-256-GCM at rest, never returned to a client</DetailRow>
            <DetailRow label="Audit log">Append-only — no update or delete path exists</DetailRow>
            <DetailRow label="Rate limiting">Database-backed, survives restarts and spans instances</DetailRow>
            <DetailRow label="Analytics queries">
              Pre-approved read-only templates; no model-generated SQL
            </DetailRow>
            <DetailRow label="Agent authority">
              Clamped to the live role of the authorizing user, re-resolved per run
            </DetailRow>
          </dl>
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Audit trail</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              Who did what, on whose authority, and which approval permitted it
            </p>
          </div>
        </CardHeader>
        <CardBody className="px-0 pt-0 pb-0">
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Resource</Th>
                <Th>Risk</Th>
                <Th align="right">When</Th>
              </Tr>
            </Thead>
            <Tbody>
              {events.length === 0 ? (
                <Tr className="hover:bg-transparent">
                  <Td colSpan={5}>
                    <p className="py-6 text-center text-xs text-text-subtle">No audit events yet.</p>
                  </Td>
                </Tr>
              ) : (
                events.map((event) => (
                  <Tr key={event.id}>
                    <Td>
                      <span className="font-mono text-2xs text-text">{event.action}</span>
                      {event.changes && Object.keys(event.changes).length > 0 && (
                        <span className="mt-0.5 block text-[10px] text-text-subtle">
                          {Object.entries(event.changes)
                            .slice(0, 2)
                            .map(([field, change]) => `${field}: ${format(change.from)} → ${format(change.to)}`)
                            .join(', ')}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-xs text-text-muted">{event.actorLabel ?? '—'}</span>
                      <Badge
                        tone={
                          event.actorType === 'agent'
                            ? 'accent'
                            : event.actorType === 'system'
                              ? 'neutral'
                              : 'outline'
                        }
                        className="ml-1.5"
                      >
                        {event.actorType}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="text-2xs text-text-subtle">
                        {event.resourceType ?? '—'}
                        {event.resourceId && (
                          <span className="ml-1 font-mono opacity-60">
                            {event.resourceId.slice(0, 12)}
                          </span>
                        )}
                      </span>
                    </Td>
                    <Td>
                      {event.riskLevel ? (
                        <Badge
                          tone={
                            event.riskLevel === 'high'
                              ? 'danger'
                              : event.riskLevel === 'medium'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {event.riskLevel}
                        </Badge>
                      ) : (
                        <span className="text-2xs text-text-subtle">—</span>
                      )}
                    </Td>
                    <Td align="right">
                      <span className="text-2xs text-text-subtle">
                        {relativeTime(event.occurredAt)}
                      </span>
                    </Td>
                  </Tr>
                ))
              )}
            </Tbody>
          </Table>
        </CardBody>
      </Card>

      <ApiKeysPanel keys={apiKeys} maxRole={ctx.role} />

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          <ul className="space-y-2">
            {activeSessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-text">{session.userName}</p>
                  <p className="truncate text-2xs text-text-subtle">
                    {session.userAgent?.slice(0, 70) ?? 'Unknown client'}
                  </p>
                </div>
                <span className="shrink-0 text-2xs text-text-subtle">
                  started {relativeTime(session.createdAt)} · expires {shortDate(session.expiresAt)}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  const s = String(value);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}
