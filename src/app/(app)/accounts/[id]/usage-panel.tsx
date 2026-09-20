import { sql } from 'drizzle-orm';
import { listSupportTickets, powerUsers, usageTrends } from '@/server/memory/external';
import { rawQuery } from '@/server/db-query';
import type { Ctx } from '@/server/context';
import { Badge, Card, CardBody, CardHeader, CardTitle, SectionLabel, Stat } from '@/components/ui/primitives';
import { TrendDown, TrendUp } from '@/components/layout/icons';
import { number, relativeTime, titleCase } from '@/lib/utils';

/**
 * Product usage and support, on the account page.
 *
 * This is the half of the relationship a conventional CRM cannot see: someone
 * can be replying warmly to every email while their team quietly stops opening
 * the product. Rendered only when the workspace has actually ingested usage or
 * tickets — an account with no product data shows nothing rather than a row of
 * zeroes pretending to be a measurement.
 */
export async function UsagePanel({ ctx, accountId }: { ctx: Ctx; accountId: string }) {
  const [trends, champions, tickets, sparkline] = await Promise.all([
    usageTrends(ctx, 0),
    powerUsers(ctx, 60),
    listSupportTickets(ctx, { accountId, limit: 6 }),
    rawQuery<{ day: string; active_users: number }>(
      ctx,
      sql`
        SELECT to_char(u.day, 'YYYY-MM-DD') AS day, u.active_users
        FROM usage_daily u
        WHERE u.workspace_id = ${ctx.workspaceId}
          AND u.account_id = ${accountId}
          AND u.contact_id IS NULL
          AND u.day >= now() - interval '60 days'
        ORDER BY u.day ASC
      `,
    ),
  ]);

  const trend = trends.find((t) => t.accountId === accountId) ?? null;
  const mine = champions.filter((c) => c.accountId === accountId).slice(0, 4);

  if (!trend && mine.length === 0 && tickets.length === 0) return null;

  const open = tickets.filter((t) => t.status === 'open' || t.status === 'pending');
  const tone =
    trend?.trend === 'growing'
      ? 'success'
      : trend?.trend === 'declining' || trend?.trend === 'dormant'
        ? 'danger'
        : 'neutral';

  return (
    <Card className="mt-5">
      <CardHeader>
        <div>
          <CardTitle>Product usage &amp; support</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">
            Ingested from product analytics and the support desk — the behaviour behind the
            conversation
          </p>
        </div>
        {trend && (
          <Badge tone={tone}>
            {trend.trend === 'growing' ? (
              <TrendUp className="size-3" />
            ) : trend.trend === 'declining' || trend.trend === 'dormant' ? (
              <TrendDown className="size-3" />
            ) : null}
            {titleCase(trend.trend)}
          </Badge>
        )}
      </CardHeader>

      <CardBody className="pt-0">
        {trend && (
          <>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Stat
                label="Daily active users"
                value={number(trend.recentActiveUsers)}
                hint={`${trend.priorActiveUsers} in the prior 30 days`}
              />
              <Stat
                label="Change"
                value={`${trend.changePercent > 0 ? '+' : ''}${trend.changePercent}%`}
              />
              <Stat label="Key actions (30d)" value={number(trend.recentKeyActions)} />
              <Stat label="Open tickets" value={number(open.length)} />
            </div>

            {sparkline.length > 3 && <Sparkline points={sparkline.map((p) => p.active_users)} />}
          </>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <SectionLabel>Power users</SectionLabel>
            {mine.length === 0 ? (
              <p className="mt-1.5 text-xs text-text-subtle">
                Nobody at this account is doing enough in the product to count as a power user.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {mine.map((person) => (
                  <li
                    key={person.contactId}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0 truncate text-text">{person.name}</span>
                    <span className="shrink-0 text-2xs tabular text-text-subtle">
                      {number(person.keyActions)} actions · {person.activeDays}d active
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <SectionLabel>Recent tickets</SectionLabel>
            {tickets.length === 0 ? (
              <p className="mt-1.5 text-xs text-text-subtle">No support tickets on record.</p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {tickets.map((ticket) => (
                  <li key={ticket.id} className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <Badge
                        tone={
                          ticket.priority === 'urgent'
                            ? 'danger'
                            : ticket.priority === 'high'
                              ? 'warning'
                              : 'neutral'
                        }
                        size="sm"
                      >
                        {ticket.priority}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-xs text-text">
                        {ticket.subject}
                      </span>
                    </div>
                    <p className="mt-0.5 text-2xs text-text-subtle">
                      {titleCase(ticket.status)} · opened {relativeTime(ticket.openedAt)}
                      {ticket.satisfaction != null ? ` · rated ${ticket.satisfaction}/5` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Sixty days of daily active users.
 *
 * Inline SVG rather than a charting library: one polyline does not justify
 * shipping a dependency to every client that opens an account.
 */
function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(...points, 1);
  const width = 600;
  const height = 48;
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const path = points
    .map((value, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ');

  return (
    <div className="mt-4">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-12 w-full overflow-visible text-accent"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Daily active users over the last ${points.length} days, peaking at ${max}`}
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-3xs text-text-subtle">
        <span>60 days ago</span>
        <span>peak {max}</span>
        <span>today</span>
      </div>
    </div>
  );
}
