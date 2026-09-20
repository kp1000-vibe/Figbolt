import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { accounts, commitments, contacts, meetings, opportunities } from '@/db/schema';
import { requireCtx, scope, scoped } from '@/server/context';
import { UnauthenticatedError } from '@/lib/auth/session';
import { getLanguageModel } from '@/lib/ai';
import { s } from '@/lib/ai/providers/structured';
import { search } from '@/server/retrieval/search';
import { checkRateLimit } from '@/server/rate-limit';

/**
 * Prepare a follow-up draft.
 *
 * Composed from recorded commitments, open questions and agreed next steps, so
 * the draft recaps a real conversation rather than producing generic filler.
 * It returns text only — nothing is stored or sent until the user saves it,
 * and saving goes through the approval path like any other outbound action.
 */

const schema = z.object({
  accountId: z.string().optional(),
  opportunityId: z.string().optional(),
  contactId: z.string().optional(),
  purpose: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  let ctx: Awaited<ReturnType<typeof requireCtx>>;
  try {
    ctx = await requireCtx();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
    }
    throw err;
  }

  const limit = await checkRateLimit(`draft:${ctx.workspaceId}:${ctx.userId}`, 30, 60);
  if (!limit.allowed) return NextResponse.json({ error: 'Slow down.' }, { status: 429 });

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  const { accountId, opportunityId, contactId, purpose } = parsed.data;
  if (!accountId && !opportunityId && !contactId) {
    return NextResponse.json({ error: 'Nothing to draft against.' }, { status: 400 });
  }

  // Resolve the account from whichever handle we were given.
  let resolvedAccountId = accountId ?? null;
  if (!resolvedAccountId && opportunityId) {
    const [opp] = await ctx.db
      .select({ accountId: opportunities.accountId })
      .from(opportunities)
      .where(and(scope(ctx, opportunities), eq(opportunities.id, opportunityId)))
      .limit(1);
    resolvedAccountId = opp?.accountId ?? null;
  }
  if (!resolvedAccountId && contactId) {
    const [contact] = await ctx.db
      .select({ accountId: contacts.accountId })
      .from(contacts)
      .where(and(scope(ctx, contacts), eq(contacts.id, contactId)))
      .limit(1);
    resolvedAccountId = contact?.accountId ?? null;
  }
  if (!resolvedAccountId) {
    return NextResponse.json({ error: 'Could not resolve the account.' }, { status: 404 });
  }

  const [[account], recipients, openCommitments, [lastMeeting]] = await Promise.all([
    ctx.db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(scope(ctx, accounts), eq(accounts.id, resolvedAccountId)))
      .limit(1),
    ctx.db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        buyingRole: contacts.buyingRole,
      })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(contacts.accountId, resolvedAccountId)))
      .orderBy(desc(contacts.isPrimary), desc(contacts.influence)),
    ctx.db
      .select({
        description: commitments.description,
        direction: commitments.direction,
        dueAt: commitments.dueAt,
      })
      .from(commitments)
      .where(
        scoped(
          ctx,
          commitments,
          eq(commitments.accountId, resolvedAccountId),
          inArray(commitments.status, ['open', 'overdue']),
        ),
      )
      .limit(10),
    ctx.db
      .select({
        title: meetings.title,
        startsAt: meetings.startsAt,
        intelligence: meetings.intelligence,
      })
      .from(meetings)
      .where(
        scoped(ctx, meetings, eq(meetings.accountId, resolvedAccountId), eq(meetings.status, 'completed')),
      )
      .orderBy(desc(meetings.startsAt))
      .limit(1),
  ]);

  if (!account) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

  const recipient =
    (contactId ? recipients.find((r) => r.id === contactId) : undefined) ??
    recipients.find((r) => r.buyingRole === 'champion') ??
    recipients[0];

  if (!recipient?.email) {
    return NextResponse.json(
      { error: 'No contact with an email address on this account.' },
      { status: 400 },
    );
  }

  const evidence = await search(ctx, {
    query: `${account.name} next steps commitments open questions`,
    accountId: resolvedAccountId,
    opportunityId,
    scopes: ['emails', 'meetings', 'transcripts', 'commitments'],
    limit: 10,
    includeRecent: 5,
  });

  const ourCommitments = openCommitments
    .filter((c) => c.direction === 'we_owe')
    .map((c) => c.description);
  const nextSteps = lastMeeting?.intelligence?.nextSteps ?? [];
  const openQuestions = lastMeeting?.intelligence?.questions?.slice(0, 3) ?? [];

  const model = getLanguageModel();
  const result = await model.completeStructured<{ subject: string; body: string }>({
    system: [
      'You draft short, direct follow-up emails for a B2B sales team.',
      '',
      'Rules:',
      '- Reference only what is in the evidence. Never invent a commitment or a date.',
      '- No marketing language, no filler, no exclamation marks.',
      '- Six short paragraphs at most. Bullets for lists of commitments.',
      '- Close by inviting a correction if anything is wrong.',
    ].join('\n'),
    instruction: [
      `recipientFirstName: ${recipient.firstName}`,
      `senderName: ${ctx.session.user.name}`,
      `accountName: ${account.name}`,
      `purpose: ${purpose ?? 'follow up on where things stand'}`,
      lastMeeting ? `lastMeetingTitle: ${lastMeeting.title}` : '',
      lastMeeting ? `lastMeetingDate: ${lastMeeting.startsAt.toISOString().slice(0, 10)}` : '',
      ourCommitments.length
        ? `openCommitments:\n${ourCommitments.map((c) => `- ${c}`).join('\n')}`
        : '',
      openQuestions.length ? `openQuestions:\n${openQuestions.map((q) => `- ${q}`).join('\n')}` : '',
      nextSteps.length ? `nextSteps:\n${nextSteps.map((n) => `- ${n}`).join('\n')}` : '',
      '',
      `Draft a follow-up email to ${recipient.firstName} at ${account.name}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    schema: s.object(
      {
        subject: s.string('Email subject line.'),
        body: s.string('Plain-text email body with real line breaks.'),
        confidence: s.number('0-1.'),
      },
      ['subject', 'body', 'confidence'],
    ),
    task: 'draft_email',
    evidence,
  });

  return NextResponse.json(
    {
      to: [recipient.email],
      subject: result.value.subject,
      body: result.value.body,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
