import { sql } from 'drizzle-orm';
import { contacts, usageDaily } from '@/db/schema';
import { ingestSupportTicket } from '@/server/memory/external';
import type { Ctx } from '@/server/context';

/**
 * Product-usage and support-ticket demo data.
 *
 * These are the two signals a conventional CRM never sees, so the demo has to
 * contain them or the churn and expansion detectors have nothing to find. As
 * everywhere else in the seed, only *raw* sources are written: usage rollups
 * and ticket text. Every derived thing — the churn objection, the product
 * signal, the account health penalty, the cross-account insight — is produced
 * by the real engine reading these rows.
 *
 * The patterns are deliberate and discoverable:
 *
 *  - Three customers with collapsing usage (one fully dormant) while their
 *    email threads still read as friendly. That gap is the whole point.
 *  - Three customers whose usage is climbing while the only thing open is a
 *    renewal priced flat against current ARR.
 *  - One ticket whose text is simultaneously a bug report, a product signal
 *    and a churn risk, so a single raw source lights up three surfaces.
 */

type UsageProfile = {
  accountName: string;
  /** Mean daily active users 60–31 days ago. */
  prior: number;
  /** Mean daily active users in the last 30 days. */
  recent: number;
  /** Key actions per day per tracked person in the recent window. */
  championActions: number;
  /** How many named contacts to track individually. */
  champions: number;
};

const USAGE: UsageProfile[] = [
  // Collapsing — the churn cohort.
  { accountName: 'Brightpath Retail', prior: 22, recent: 12, championActions: 1, champions: 1 },
  { accountName: 'Vertex Manufacturing', prior: 18, recent: 10, championActions: 1, champions: 1 },
  { accountName: 'Solstice Energy', prior: 9, recent: 0, championActions: 0, champions: 0 },
  // Climbing — the expansion cohort.
  { accountName: 'Granite Construction Partners', prior: 11, recent: 17, championActions: 4, champions: 2 },
  { accountName: 'Ashford Education Group', prior: 6, recent: 9, championActions: 3, champions: 1 },
  { accountName: 'Willow Creek Bank', prior: 9, recent: 13, championActions: 2, champions: 2 },
  // Growing too, but its open pipeline already exceeds current ARR — so it is
  // correctly *excluded* from the expansion insight. A filter nobody can see
  // working is a filter nobody trusts.
  { accountName: 'Pinecrest Media', prior: 5, recent: 7, championActions: 3, champions: 1 },
];

type TicketSeed = {
  accountName: string;
  contactIndex?: number;
  externalId: string;
  subject: string;
  body: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  daysAgo: number;
  satisfaction?: number;
};

const TICKETS: TicketSeed[] = [
  {
    accountName: 'Solstice Energy',
    externalId: 'ZD-4411',
    subject: 'Nobody on my team is using this any more',
    body:
      "I'll be honest with you. We rolled this out to the field supervisors in March and by May almost all of them had gone back to the old spreadsheet. " +
      'The mobile view is unusable on the tablets they actually carry, and every shift handover needs four taps that they do not have gloves off for. ' +
      'I have a renewal conversation with procurement in November and right now I cannot justify it. We are going to have to seriously reconsider at renewal unless something changes on the mobile side.',
    status: 'open',
    priority: 'urgent',
    daysAgo: 9,
  },
  {
    accountName: 'Vertex Manufacturing',
    externalId: 'ZD-4386',
    subject: 'Salesforce sync failing silently since the 14th',
    body:
      'Our nightly Salesforce sync has been failing since the 14th and nothing alerted us. We found it because a plant manager asked why the work order counts were three weeks stale. ' +
      'The job log shows a 401 and then nothing. Two problems here: the sync is broken, and a broken sync is invisible. ' +
      'We need failure notifications, otherwise we cannot trust the numbers we report to the operations committee.',
    status: 'open',
    priority: 'urgent',
    daysAgo: 12,
  },
  {
    accountName: 'Vertex Manufacturing',
    externalId: 'ZD-4402',
    subject: 'Bulk export times out above about 8,000 rows',
    body:
      'When I try to export the full deviation log for the quarter the request runs for about ninety seconds and then returns a gateway error. ' +
      'Anything under roughly eight thousand rows comes back fine. I need the full quarter for the audit pack.',
    status: 'pending',
    priority: 'high',
    daysAgo: 6,
  },
  {
    accountName: 'Brightpath Retail',
    externalId: 'ZD-4377',
    subject: 'Store managers cannot see the exception queue on mobile',
    body:
      'The exception queue is the one thing store managers need on their phones and it is the one view that does not fit. ' +
      'They end up calling the regional office instead, which defeats the purpose of rolling it out to stores at all.',
    status: 'open',
    priority: 'high',
    daysAgo: 15,
  },
  {
    accountName: 'Brightpath Retail',
    externalId: 'ZD-4340',
    subject: 'Duplicate replenishment alerts',
    body:
      'We are getting the same replenishment alert two or three times for one event. The team has started ignoring them, which is worse than not having them.',
    status: 'open',
    priority: 'normal',
    daysAgo: 22,
  },
  {
    accountName: 'Granite Construction Partners',
    externalId: 'ZD-4395',
    subject: 'Can we get change-order approvals routed by project value?',
    body:
      'Right now every change order goes to the same approver regardless of value. We would like anything under $10k to route to the project manager and anything above to the regional director. ' +
      'We are adding eleven sites this quarter and the single approver is already the bottleneck.',
    status: 'open',
    priority: 'normal',
    daysAgo: 8,
  },
  {
    accountName: 'Granite Construction Partners',
    externalId: 'ZD-4361',
    subject: 'Thanks for the quick turnaround on the API limit',
    body:
      'Whoever raised our rate limit yesterday, thank you. The nightly Procore pull finished in eleven minutes instead of failing halfway through.',
    status: 'resolved',
    priority: 'low',
    daysAgo: 19,
    satisfaction: 5,
  },
  {
    accountName: 'Ashford Education Group',
    externalId: 'ZD-4399',
    subject: 'SSO group mapping for the new campuses',
    body:
      'We are onboarding two more campuses in October and want their staff provisioned from our Azure groups rather than by hand. ' +
      'Is SCIM available on our plan, or do we need to move up a tier?',
    status: 'pending',
    priority: 'normal',
    daysAgo: 5,
  },
  {
    accountName: 'Ashford Education Group',
    externalId: 'ZD-4352',
    subject: 'Report scheduling worked perfectly',
    body: 'Set up the weekly enrolment report for the registrar team and it has arrived on time every Monday. Exactly what we needed.',
    status: 'closed',
    priority: 'low',
    daysAgo: 26,
    satisfaction: 5,
  },
  {
    accountName: 'Pinecrest Media',
    externalId: 'ZD-4404',
    subject: 'Approval notifications going to the wrong producer',
    body:
      'Post-production approvals are notifying the previous owner of the project rather than the current one. It has caused two missed deadlines this month.',
    status: 'open',
    priority: 'high',
    daysAgo: 4,
  },
  {
    accountName: 'Willow Creek Bank',
    externalId: 'ZD-4390',
    subject: 'Audit log retention question',
    body:
      'Our examiners have asked how long audit events are retained and whether we can export them. Can you confirm the retention period in writing so I can attach it to the exam response?',
    status: 'resolved',
    priority: 'normal',
    daysAgo: 11,
    satisfaction: 4,
  },
  {
    accountName: 'Willow Creek Bank',
    externalId: 'ZD-4368',
    subject: 'Servicing queue filters reset on reload',
    body: 'Every time the servicing team reloads, their queue filters reset to the default. Small thing, but they reload constantly.',
    status: 'resolved',
    priority: 'low',
    daysAgo: 17,
    satisfaction: 4,
  },
  {
    accountName: 'Acme Corp',
    externalId: 'ZD-4408',
    subject: 'SOC 2 report for the security review',
    body:
      'Our security team needs the current SOC 2 Type II report and the penetration test summary before they will sign off. Can you send both to me directly?',
    status: 'pending',
    priority: 'high',
    daysAgo: 3,
  },
  {
    accountName: 'Halcyon Health',
    externalId: 'ZD-4406',
    subject: 'Does audit logging cover record views as well as edits?',
    body:
      'For HIPAA we have to be able to show who *looked at* a record, not only who changed it. Does the audit log capture read events today?',
    status: 'open',
    priority: 'high',
    daysAgo: 7,
  },
];

export async function seedProductAndSupportSignals(
  ctx: Ctx,
  accountIds: { id: string; name: string }[],
): Promise<{ usageRows: number; tickets: number }> {
  const byName = new Map(accountIds.map((a) => [a.name, a.id]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  type Row = typeof usageDaily.$inferInsert;
  const rows: Row[] = [];

  for (const profile of USAGE) {
    const accountId = byName.get(profile.accountName);
    if (!accountId) continue;

    const roster = await ctx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(sql`${contacts.workspaceId} = ${ctx.workspaceId} AND ${contacts.accountId} = ${accountId}`)
      .orderBy(contacts.createdAt)
      .limit(profile.champions);

    for (let back = 59; back >= 0; back--) {
      const day = new Date(today.getTime() - back * 86_400_000);
      const weekday = day.getUTCDay();
      // Business software: weekends are genuinely quiet. Without this the
      // trend lines look synthetic and the detectors get an easier problem
      // than they would in production.
      const weekendFactor = weekday === 0 || weekday === 6 ? 0.25 : 1;

      const base = back >= 30 ? profile.prior : profile.recent;
      // A gentle deterministic wobble so no two days are identical.
      const wobble = 1 + (((back * 37) % 11) - 5) / 40;
      const activeUsers = Math.max(0, Math.round(base * weekendFactor * wobble));

      rows.push({
        workspaceId: ctx.workspaceId,
        accountId,
        contactId: null,
        day,
        activeUsers,
        sessions: Math.round(activeUsers * 2.4),
        events: Math.round(activeUsers * 31),
        keyActions: Math.round(activeUsers * 3.2),
        source: 'posthog',
      });

      // Per-contact rows exist only for the recent window — they are what the
      // power-user query reads, and they are never summed into account totals.
      if (back < 30) {
        for (const [index, person] of roster.entries()) {
          const personFactor = index === 0 ? 1 : 0.7;
          const actions = Math.round(
            profile.championActions * 14 * personFactor * weekendFactor * wobble,
          );
          if (actions <= 0) continue;
          rows.push({
            workspaceId: ctx.workspaceId,
            accountId,
            contactId: person.id,
            day,
            activeUsers: 1,
            sessions: Math.max(1, Math.round(actions / 6)),
            events: actions * 9,
            keyActions: actions,
            source: 'posthog',
          });
        }
      }
    }
  }

  // Chunked because PGlite, like any Postgres, has a bind-parameter ceiling.
  for (let i = 0; i < rows.length; i += 500) {
    await ctx.db.insert(usageDaily).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }

  let tickets = 0;
  for (const ticket of TICKETS) {
    const accountId = byName.get(ticket.accountName);
    if (!accountId) continue;

    const [contact] = await ctx.db
      .select({ email: contacts.email })
      .from(contacts)
      .where(sql`${contacts.workspaceId} = ${ctx.workspaceId} AND ${contacts.accountId} = ${accountId}`)
      .orderBy(contacts.createdAt)
      .limit(1)
      .offset(ticket.contactIndex ?? 0);

    await ingestSupportTicket(ctx, {
      externalId: ticket.externalId,
      provider: 'zendesk',
      subject: ticket.subject,
      body: ticket.body,
      status: ticket.status,
      priority: ticket.priority,
      accountId,
      ...(contact?.email ? { contactEmail: contact.email } : {}),
      openedAt: new Date(today.getTime() - ticket.daysAgo * 86_400_000).toISOString(),
      ...(ticket.satisfaction != null ? { satisfaction: ticket.satisfaction } : {}),
    });
    tickets++;
  }

  return { usageRows: rows.length, tickets };
}
