import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  crmEvents,
  emails,
  meetingParticipants,
  meetings,
  opportunities,
  relationships,
  tasks,
  users,
} from '@/db/schema';
import { NotFoundError, scope, scoped, type Ctx } from '../context';
import { rawQuery } from '../db-query';
import { engagementStats } from '../memory/timeline';

export type ContactFilters = {
  query?: string;
  accountId?: string;
  buyingRole?: string;
  seniority?: string;
  ownerId?: string;
  sort?: 'name' | 'influence' | 'activity' | 'account';
  limit?: number;
};

export async function listContacts(ctx: Ctx, filters: ContactFilters = {}) {
  const orderBy = (() => {
    switch (filters.sort) {
      case 'influence':
        return [desc(contacts.influence), asc(contacts.lastName)];
      case 'activity':
        return [desc(contacts.lastInteractionAt)];
      case 'account':
        return [asc(accounts.name), asc(contacts.lastName)];
      default:
        return [asc(contacts.lastName), asc(contacts.firstName)];
    }
  })();

  const [rows, [count]] = await Promise.all([
    ctx.db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        title: contacts.title,
        seniority: contacts.seniority,
        department: contacts.department,
        buyingRole: contacts.buyingRole,
        influence: contacts.influence,
        sentiment: contacts.sentiment,
        lastInteractionAt: contacts.lastInteractionAt,
        isPrimary: contacts.isPrimary,
        accountId: contacts.accountId,
        accountName: accounts.name,
        ownerName: users.name,
      })
      .from(contacts)
      .leftJoin(accounts, eq(accounts.id, contacts.accountId))
      .leftJoin(users, eq(users.id, contacts.ownerId))
      .where(
        scoped(
          ctx,
          contacts,
          filters.query
            ? or(
                ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, `%${filters.query}%`),
                ilike(contacts.email, `%${filters.query}%`),
                ilike(contacts.title, `%${filters.query}%`),
                ilike(accounts.name, `%${filters.query}%`),
              )
            : undefined,
          filters.accountId ? eq(contacts.accountId, filters.accountId) : undefined,
          filters.buyingRole ? eq(contacts.buyingRole, filters.buyingRole as never) : undefined,
          filters.seniority ? eq(contacts.seniority, filters.seniority as never) : undefined,
          filters.ownerId ? eq(contacts.ownerId, filters.ownerId) : undefined,
        ),
      )
      .orderBy(...orderBy)
      .limit(Math.min(filters.limit ?? 100, 300)),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(scope(ctx, contacts)),
  ]);

  return { rows, total: count?.n ?? 0 };
}

export async function getContactDetail(ctx: Ctx, contactId: string) {
  const [row] = await ctx.db
    .select({
      contact: contacts,
      accountName: accounts.name,
      accountId: accounts.id,
      accountHealth: accounts.healthScore,
      ownerName: users.name,
    })
    .from(contacts)
    .leftJoin(accounts, eq(accounts.id, contacts.accountId))
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(scope(ctx, contacts), eq(contacts.id, contactId)))
    .limit(1);

  if (!row) throw new NotFoundError('Contact', contactId);
  const contact = row.contact;

  const [contactEmails, contactMeetings, ownedCommitments, contactTasks, timeline, edges, engagement, deals] =
    await Promise.all([
      ctx.db
        .select({
          id: emails.id,
          subject: emails.subject,
          snippet: emails.bodySnippet,
          direction: emails.direction,
          sentAt: emails.sentAt,
          sentiment: emails.sentiment,
        })
        .from(emails)
        .where(
          scoped(
            ctx,
            emails,
            or(
              eq(emails.contactId, contactId),
              contact.email ? eq(sql`lower(${emails.fromEmail})`, contact.email.toLowerCase()) : undefined,
            ),
          ),
        )
        .orderBy(desc(emails.sentAt))
        .limit(25),

      ctx.db
        .select({
          id: meetings.id,
          title: meetings.title,
          startsAt: meetings.startsAt,
          talkRatio: meetingParticipants.talkRatio,
          attended: meetingParticipants.attended,
          intelligence: meetings.intelligence,
        })
        .from(meetingParticipants)
        .innerJoin(meetings, eq(meetings.id, meetingParticipants.meetingId))
        .where(scoped(ctx, meetingParticipants, eq(meetingParticipants.contactId, contactId)))
        .orderBy(desc(meetings.startsAt))
        .limit(20),

      ctx.db
        .select()
        .from(commitments)
        .where(scoped(ctx, commitments, eq(commitments.ownerContactId, contactId)))
        .orderBy(asc(commitments.dueAt))
        .limit(15),

      ctx.db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          dueAt: tasks.dueAt,
          priority: tasks.priority,
        })
        .from(tasks)
        .where(scoped(ctx, tasks, eq(tasks.contactId, contactId)))
        .orderBy(asc(tasks.dueAt))
        .limit(15),

      ctx.db
        .select()
        .from(crmEvents)
        .where(scoped(ctx, crmEvents, eq(crmEvents.contactId, contactId)))
        .orderBy(desc(crmEvents.occurredAt))
        .limit(50),

      ctx.db
        .select()
        .from(relationships)
        .where(
          scoped(
            ctx,
            relationships,
            or(
              and(eq(relationships.fromType, 'contact'), eq(relationships.fromId, contactId)),
              and(eq(relationships.toType, 'contact'), eq(relationships.toId, contactId)),
            ),
          ),
        ),

      engagementStats(ctx, { accountId: contact.accountId ?? undefined }, 90),

      contact.accountId
        ? ctx.db
            .select({
              id: opportunities.id,
              name: opportunities.name,
              value: opportunities.value,
              status: opportunities.status,
              healthScore: opportunities.healthScore,
            })
            .from(opportunities)
            .where(scoped(ctx, opportunities, eq(opportunities.accountId, contact.accountId)))
            .limit(10)
        : Promise.resolve([]),
    ]);

  return {
    contact,
    account: row.accountId
      ? { id: row.accountId, name: row.accountName, healthScore: row.accountHealth }
      : null,
    ownerName: row.ownerName,
    emails: contactEmails,
    meetings: contactMeetings,
    commitments: ownedCommitments,
    tasks: contactTasks,
    timeline,
    relationships: edges,
    engagement,
    opportunities: deals,
  };
}

export async function getContactFacets(ctx: Ctx) {
  const [owners, roleCounts] = await Promise.all([
    ctx.db
      .selectDistinct({ id: users.id, name: users.name })
      .from(contacts)
      .innerJoin(users, eq(users.id, contacts.ownerId))
      .where(scope(ctx, contacts))
      .orderBy(users.name),
    rawQuery<{ value: string; n: number }>(
      ctx,
      sql`SELECT buying_role AS value, count(*)::int AS n
          FROM contacts
          WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL
            AND buying_role IS NOT NULL AND buying_role <> 'unknown'
          GROUP BY 1 ORDER BY 2 DESC`,
    ),
  ]);
  return { owners, roleCounts };
}
