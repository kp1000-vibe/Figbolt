import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  accounts,
  contacts,
  supportTickets,
  usageDaily,
  type SourceRef,
} from '@/db/schema';
import { scope, scoped, ValidationError, type Ctx } from '../context';
import { record } from '../audit';
import { addActivity, addTimelineEvent } from './timeline';
import { indexForSearch, resolveParties } from './ingest';
import { scoreSentiment } from '@/lib/ai/local/extract';
import { rawQuery } from '../db-query';

/**
 * Ingestion for the non-conversational sources.
 *
 * Product usage and support tickets are the two signals that tell you a
 * customer is in trouble *before* they say so in an email — so they belong in
 * the customer model, not in a separate analytics tool the CRM cannot see.
 *
 * Tickets go through the same extraction pipeline as email, because a ticket is
 * a customer telling you something is wrong. Usage is rolled up daily rather
 * than stored per-event: the questions the CRM asks are "is this falling?" and
 * "who are the power users?", and raw events buy no extra signal for either.
 */

/* ── Product usage ────────────────────────────────────────────────────────── */

/**
 * Two kinds of usage row, one table:
 *
 *  - `contact_id IS NULL` — the account-level daily rollup. Every account
 *    metric (active users, sessions, events, key actions) is read from these.
 *  - `contact_id` set — one person's activity that day. These exist to
 *    identify power users and are never summed into account totals, so the
 *    two kinds cannot double-count each other.
 */
export type UsageInput = {
  accountId?: string;
  accountDomain?: string;
  contactEmail?: string;
  day: string;
  activeUsers?: number;
  sessions?: number;
  events?: number;
  keyActions?: number;
  source?: string;
};

export async function ingestExternalUsage(
  ctx: Ctx,
  input: UsageInput,
): Promise<{ accountId: string; day: string; created: boolean }> {
  const accountId = await resolveAccount(ctx, input.accountId, input.accountDomain);
  if (!accountId) {
    throw new ValidationError(
      'Could not resolve an account. Pass accountId, or an accountDomain that matches a known account.',
    );
  }

  const day = new Date(input.day);
  if (Number.isNaN(day.getTime())) throw new ValidationError('"day" must be an ISO date.');
  // Normalise to a UTC midnight so upserts collapse onto one row per day.
  day.setUTCHours(0, 0, 0, 0);

  let contactId: string | null = null;
  if (input.contactEmail) {
    const [contact] = await ctx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(sql`lower(${contacts.email})`, input.contactEmail.toLowerCase())))
      .limit(1);
    contactId = contact?.id ?? null;
  }

  await ctx.db
    .insert(usageDaily)
    .values({
      workspaceId: ctx.workspaceId,
      accountId,
      contactId,
      day,
      activeUsers: input.activeUsers ?? 0,
      sessions: input.sessions ?? 0,
      events: input.events ?? 0,
      keyActions: input.keyActions ?? 0,
      source: input.source ?? 'api',
    })
    .onConflictDoUpdate({
      target: [usageDaily.workspaceId, usageDaily.accountId, usageDaily.contactId, usageDaily.day],
      // Replace rather than accumulate: a re-send of the same day is a
      // correction, not additional usage.
      set: {
        activeUsers: input.activeUsers ?? 0,
        sessions: input.sessions ?? 0,
        events: input.events ?? 0,
        keyActions: input.keyActions ?? 0,
        updatedAt: new Date(),
      },
    });

  return { accountId, day: day.toISOString().slice(0, 10), created: true };
}

export type UsageTrend = {
  accountId: string;
  accountName: string;
  recentActiveUsers: number;
  priorActiveUsers: number;
  recentKeyActions: number;
  priorKeyActions: number;
  changePercent: number;
  trend: 'growing' | 'steady' | 'declining' | 'dormant';
};

/**
 * Usage trend per account, comparing the last 30 days to the 30 before.
 *
 * `dormant` is distinguished from `declining` because they call for different
 * responses: dormant is a save motion, declining is a conversation.
 */
export async function usageTrends(ctx: Ctx, minPriorUsers = 1): Promise<UsageTrend[]> {
  const rows = await rawQuery<{
    account_id: string;
    account_name: string;
    recent_users: number;
    prior_users: number;
    recent_actions: number;
    prior_actions: number;
  }>(
    ctx,
    sql`
      SELECT a.id AS account_id, a.name AS account_name,
             COALESCE(AVG(u.active_users) FILTER (WHERE u.day >= now() - interval '30 days'), 0)::float8 AS recent_users,
             COALESCE(AVG(u.active_users) FILTER (
               WHERE u.day < now() - interval '30 days' AND u.day >= now() - interval '60 days'
             ), 0)::float8 AS prior_users,
             COALESCE(SUM(u.key_actions) FILTER (WHERE u.day >= now() - interval '30 days'), 0)::int AS recent_actions,
             COALESCE(SUM(u.key_actions) FILTER (
               WHERE u.day < now() - interval '30 days' AND u.day >= now() - interval '60 days'
             ), 0)::int AS prior_actions
      FROM accounts a
      JOIN usage_daily u ON u.account_id = a.id AND u.contact_id IS NULL
      WHERE a.workspace_id = ${ctx.workspaceId} AND a.deleted_at IS NULL
      GROUP BY a.id, a.name
      HAVING COALESCE(AVG(u.active_users) FILTER (
               WHERE u.day < now() - interval '30 days' AND u.day >= now() - interval '60 days'
             ), 0) >= ${minPriorUsers}
      ORDER BY prior_users DESC
    `,
  );

  return rows.map((r) => {
    const prior = Number(r.prior_users);
    const recent = Number(r.recent_users);
    const changePercent = prior === 0 ? 0 : Math.round(((recent - prior) / prior) * 100);

    return {
      accountId: r.account_id,
      accountName: r.account_name,
      recentActiveUsers: Math.round(recent),
      priorActiveUsers: Math.round(prior),
      recentKeyActions: r.recent_actions,
      priorKeyActions: r.prior_actions,
      changePercent,
      trend:
        recent === 0 ? 'dormant' : changePercent <= -30 ? 'declining' : changePercent >= 25 ? 'growing' : 'steady',
    };
  });
}

export type PowerUser = {
  contactId: string;
  name: string;
  accountId: string;
  accountName: string;
  keyActions: number;
  activeDays: number;
};

/**
 * The people who actually use the product.
 *
 * Worth surfacing because they are the most likely champions and the most
 * credible references — and in most CRMs they are invisible, because usage
 * lives in a different system from the relationship.
 */
export async function powerUsers(ctx: Ctx, limit = 20): Promise<PowerUser[]> {
  const rows = await rawQuery<{
    contact_id: string;
    name: string;
    account_id: string;
    account_name: string;
    key_actions: number;
    active_days: number;
  }>(
    ctx,
    sql`
      SELECT c.id AS contact_id,
             c.first_name || ' ' || c.last_name AS name,
             a.id AS account_id, a.name AS account_name,
             COALESCE(SUM(u.key_actions), 0)::int AS key_actions,
             COUNT(DISTINCT u.day)::int AS active_days
      FROM usage_daily u
      JOIN contacts c ON c.id = u.contact_id
      JOIN accounts a ON a.id = u.account_id
      WHERE u.workspace_id = ${ctx.workspaceId}
        AND u.day >= now() - interval '30 days'
        AND c.deleted_at IS NULL
      GROUP BY c.id, c.first_name, c.last_name, a.id, a.name
      HAVING COALESCE(SUM(u.key_actions), 0) > 0
      ORDER BY key_actions DESC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    contactId: r.contact_id,
    name: r.name,
    accountId: r.account_id,
    accountName: r.account_name,
    keyActions: r.key_actions,
    activeDays: r.active_days,
  }));
}

/* ── Support tickets ──────────────────────────────────────────────────────── */

export type TicketInput = {
  externalId?: string;
  provider?: string;
  subject: string;
  body?: string;
  status?: 'open' | 'pending' | 'resolved' | 'closed';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  contactEmail?: string;
  accountDomain?: string;
  accountId?: string;
  openedAt?: string;
  satisfaction?: number;
};

/**
 * Ingest a support ticket, then run the same extraction over it as an email.
 *
 * A ticket saying "the Salesforce sync keeps failing and we're going to have to
 * reconsider at renewal" is simultaneously a bug report, a product signal and a
 * churn risk. Treating it as a first-class interaction is what lets one write
 * produce all three.
 */
export async function ingestSupportTicket(
  ctx: Ctx,
  input: TicketInput,
): Promise<{ ticketId: string; accountId: string | null }> {
  const openedAt = input.openedAt ? new Date(input.openedAt) : new Date();
  if (Number.isNaN(openedAt.getTime())) {
    throw new ValidationError('"openedAt" must be an ISO timestamp.');
  }

  const parties = await resolveParties(ctx, input.contactEmail ? [input.contactEmail] : [], {
    accountId: input.accountId ?? (await resolveAccount(ctx, input.accountId, input.accountDomain)),
  });

  const body = input.body ?? '';
  const sentiment = scoreSentiment(`${input.subject}\n\n${body}`);

  // Idempotent on the provider's id, so a webhook retry updates rather than
  // duplicating.
  const existing = input.externalId
    ? (
        await ctx.db
          .select({ id: supportTickets.id })
          .from(supportTickets)
          .where(
            scoped(
              ctx,
              supportTickets,
              eq(supportTickets.provider, input.provider ?? 'api'),
              eq(supportTickets.externalId, input.externalId),
            ),
          )
          .limit(1)
      )[0]
    : undefined;

  let ticketId: string;

  if (existing) {
    await ctx.db
      .update(supportTickets)
      .set({
        subject: input.subject,
        body,
        status: input.status ?? 'open',
        priority: input.priority ?? 'normal',
        satisfaction: input.satisfaction ?? null,
        resolvedAt: input.status === 'resolved' || input.status === 'closed' ? new Date() : null,
        sentiment,
      })
      .where(and(scope(ctx, supportTickets), eq(supportTickets.id, existing.id)));
    ticketId = existing.id;
  } else {
    const [created] = await ctx.db
      .insert(supportTickets)
      .values({
        workspaceId: ctx.workspaceId,
        externalId: input.externalId ?? null,
        provider: input.provider ?? 'api',
        subject: input.subject,
        body,
        status: input.status ?? 'open',
        priority: input.priority ?? 'normal',
        satisfaction: input.satisfaction ?? null,
        accountId: parties.accountId,
        contactId: parties.contactIds[0] ?? null,
        openedAt,
        sentiment,
        processedAt: new Date(),
      })
      .returning({ id: supportTickets.id });
    ticketId = created!.id;
  }

  await indexForSearch(ctx, {
    ownerType: 'note',
    ownerId: ticketId,
    label: `Support ticket — ${input.subject}`,
    text: `${input.subject}\n\n${body}`,
    accountId: parties.accountId,
    contactId: parties.contactIds[0] ?? null,
    occurredAt: openedAt,
    metadata: { isCustomer: true, ticket: true },
  });

  if (parties.accountId) {
    await addActivity(ctx, {
      type: 'note',
      subjectType: 'account',
      subjectId: parties.accountId,
      accountId: parties.accountId,
      contactId: parties.contactIds[0] ?? null,
      title: `Support: ${input.subject}`,
      summary: body.slice(0, 200),
      direction: 'inbound',
      occurredAt: openedAt,
      sourceType: 'note',
      sourceId: ticketId,
    });

    // A high-priority or clearly unhappy ticket is a relationship event, not
    // just a support record.
    const notable = input.priority === 'urgent' || input.priority === 'high' || sentiment < -0.2;
    if (notable) {
      await addTimelineEvent(ctx, {
        type: sentiment < -0.2 ? 'sentiment_changed' : 'risk_detected',
        subjectType: 'account',
        subjectId: parties.accountId,
        accountId: parties.accountId,
        contactId: parties.contactIds[0] ?? null,
        title: `Support escalation: ${input.subject}`,
        body: body.slice(0, 400),
        importance: input.priority === 'urgent' ? 5 : 4,
        occurredAt: openedAt,
        sourceType: 'note',
        sourceId: ticketId,
      });
    }

    // Objections and product signals hide in ticket bodies as often as in email.
    if (body.length > 80) {
      const source: SourceRef = {
        type: 'note',
        id: ticketId,
        label: `Support ticket — ${input.subject}`,
        occurredAt: openedAt.toISOString(),
      };
      const { runTicketExtraction } = await import('./ticket-extraction');
      await runTicketExtraction(ctx, {
        source,
        text: body,
        accountId: parties.accountId,
        contactId: parties.contactIds[0] ?? null,
        occurredAt: openedAt,
      });
    }
  }

  await record(ctx, {
    action: existing ? 'support_ticket.updated' : 'support_ticket.ingested',
    resourceType: 'support_ticket',
    resourceId: ticketId,
    riskLevel: 'low',
    metadata: { subject: input.subject, priority: input.priority, sentiment },
  });

  return { ticketId, accountId: parties.accountId };
}

export async function listSupportTickets(
  ctx: Ctx,
  filter: { accountId?: string; status?: string; limit?: number } = {},
) {
  return ctx.db
    .select({
      id: supportTickets.id,
      subject: supportTickets.subject,
      body: supportTickets.body,
      status: supportTickets.status,
      priority: supportTickets.priority,
      satisfaction: supportTickets.satisfaction,
      sentiment: supportTickets.sentiment,
      openedAt: supportTickets.openedAt,
      resolvedAt: supportTickets.resolvedAt,
      accountId: supportTickets.accountId,
      accountName: accounts.name,
    })
    .from(supportTickets)
    .leftJoin(accounts, eq(accounts.id, supportTickets.accountId))
    .where(
      scoped(
        ctx,
        supportTickets,
        filter.accountId ? eq(supportTickets.accountId, filter.accountId) : undefined,
        filter.status ? eq(supportTickets.status, filter.status as never) : undefined,
      ),
    )
    .orderBy(desc(supportTickets.openedAt))
    .limit(filter.limit ?? 50);
}

/** Support load and satisfaction per account, for churn scoring. */
export async function supportHealth(ctx: Ctx) {
  return rawQuery<{
    account_id: string;
    account_name: string;
    open_tickets: number;
    urgent_tickets: number;
    tickets_90d: number;
    avg_sentiment: number;
    avg_satisfaction: number | null;
  }>(
    ctx,
    sql`
      SELECT a.id AS account_id, a.name AS account_name,
             COUNT(*) FILTER (WHERE t.status IN ('open', 'pending'))::int AS open_tickets,
             COUNT(*) FILTER (WHERE t.priority = 'urgent')::int AS urgent_tickets,
             COUNT(*) FILTER (WHERE t.opened_at >= now() - interval '90 days')::int AS tickets_90d,
             COALESCE(AVG(t.sentiment), 0)::float8 AS avg_sentiment,
             AVG(t.satisfaction)::float8 AS avg_satisfaction
      FROM support_tickets t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.workspace_id = ${ctx.workspaceId} AND t.deleted_at IS NULL
      GROUP BY a.id, a.name
      ORDER BY urgent_tickets DESC, open_tickets DESC
    `,
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function resolveAccount(
  ctx: Ctx,
  accountId?: string,
  domain?: string,
): Promise<string | null> {
  if (accountId) {
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(scope(ctx, accounts), eq(accounts.id, accountId)))
      .limit(1);
    return row?.id ?? null;
  }
  if (domain) {
    const clean = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(scoped(ctx, accounts, eq(sql`lower(${accounts.domain})`, clean ?? domain.toLowerCase())))
      .limit(1);
    return row?.id ?? null;
  }
  return null;
}
