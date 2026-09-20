import { and, eq } from 'drizzle-orm';
import { emailOutbox, emails, workspaces } from '@/db/schema';
import { env } from '@/lib/env';
import { scope, type Ctx } from '../context';
import { record } from '../audit';
import { addActivity, addTimelineEvent } from '../memory/timeline';

/**
 * Outbound email.
 *
 * Every message is written to `email_outbox` *before* any provider call, so
 * there is a durable record of intent even if delivery fails — and so "what
 * did the agent actually send?" is answerable from our own data rather than a
 * third party's logs.
 *
 * With `EMAIL_PROVIDER=console` nothing leaves the machine: the row is stored,
 * mirrored into the CRM thread, and logged. That is the default, because a
 * demo workspace accidentally emailing real people would be a serious bug.
 */

export interface EmailProvider {
  readonly name: string;
  readonly delivers: boolean;
  send(message: OutgoingMessage): Promise<{ id: string | null }>;
}

export type OutgoingMessage = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
};

class ConsoleProvider implements EmailProvider {
  readonly name = 'console';
  readonly delivers = false;
  async send(message: OutgoingMessage) {
    console.info(
      `[email:console] would send "${message.subject}" to ${message.to.join(', ')} (${message.body.length} chars). ` +
        'Set EMAIL_PROVIDER to deliver for real.',
    );
    return { id: null };
  }
}

class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  readonly delivers = true;
  constructor(private readonly apiKey: string) {}

  async send(message: OutgoingMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        cc: message.cc.length > 0 ? message.cc : undefined,
        subject: message.subject,
        text: message.body,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Resend rejected the message: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    }
    const json = (await res.json()) as { id?: string };
    return { id: json.id ?? null };
  }
}

export function getEmailProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY) {
    return new ResendProvider(env.RESEND_API_KEY);
  }
  if (env.EMAIL_PROVIDER !== 'console') {
    console.warn(`[email] EMAIL_PROVIDER=${env.EMAIL_PROVIDER} is not configured; falling back to console.`);
  }
  return new ConsoleProvider();
}

export type SendInput = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  draftId?: string;
  accountId?: string;
  contactId?: string;
  opportunityId?: string;
};

export type SendResult = {
  outboxId: string;
  delivered: boolean;
  provider: string;
  providerMessageId: string | null;
};

export async function sendEmail(ctx: Ctx, input: SendInput): Promise<SendResult> {
  const provider = getEmailProvider();
  const from = env.EMAIL_FROM;

  let outboxId = input.draftId ?? null;
  if (outboxId) {
    const [existing] = await ctx.db
      .select({ id: emailOutbox.id, status: emailOutbox.status })
      .from(emailOutbox)
      .where(and(scope(ctx, emailOutbox), eq(emailOutbox.id, outboxId)))
      .limit(1);
    if (!existing) outboxId = null;
    else if (existing.status === 'sent') {
      throw new Error('That message has already been sent.');
    }
  }

  if (outboxId) {
    await ctx.db
      .update(emailOutbox)
      .set({
        toEmails: input.to,
        ccEmails: input.cc ?? [],
        subject: input.subject,
        body: input.body,
        fromEmail: from,
        status: 'queued',
      })
      .where(and(scope(ctx, emailOutbox), eq(emailOutbox.id, outboxId)));
  } else {
    const [created] = await ctx.db
      .insert(emailOutbox)
      .values({
        workspaceId: ctx.workspaceId,
        toEmails: input.to,
        ccEmails: input.cc ?? [],
        fromEmail: from,
        subject: input.subject,
        body: input.body,
        status: 'queued',
        accountId: input.accountId ?? null,
        contactId: input.contactId ?? null,
        opportunityId: input.opportunityId ?? null,
        createdById: ctx.userId,
        runId: ctx.runId ?? null,
        approvalId: ctx.approvalId ?? null,
      })
      .returning({ id: emailOutbox.id });
    outboxId = created!.id;
  }

  let providerMessageId: string | null = null;
  try {
    const result = await provider.send({
      from,
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      body: input.body,
    });
    providerMessageId = result.id;
  } catch (err) {
    await ctx.db
      .update(emailOutbox)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), provider: provider.name })
      .where(eq(emailOutbox.id, outboxId));

    await record(ctx, {
      action: 'email.send_failed',
      resourceType: 'email_outbox',
      resourceId: outboxId,
      riskLevel: 'high',
      metadata: { to: input.to, subject: input.subject, error: (err as Error).message },
    });
    throw err;
  }

  const sentAt = new Date();
  await ctx.db
    .update(emailOutbox)
    .set({ status: 'sent', sentAt, provider: provider.name, providerMessageId })
    .where(eq(emailOutbox.id, outboxId));

  // Mirror into the CRM so the conversation history is complete regardless of
  // whether a mailbox integration later syncs the same message back.
  const [mirrored] = await ctx.db
    .insert(emails)
    .values({
      workspaceId: ctx.workspaceId,
      direction: 'outbound',
      fromEmail: from,
      fromName: ctx.actor.label,
      toEmails: input.to,
      ccEmails: input.cc ?? [],
      subject: input.subject,
      bodyText: input.body,
      bodySnippet: input.body.slice(0, 200),
      sentAt,
      accountId: input.accountId ?? null,
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      userId: ctx.userId,
      provider: provider.name,
      processedAt: sentAt,
    })
    .returning({ id: emails.id });

  await addActivity(ctx, {
    type: 'email',
    subjectType: 'account',
    subjectId: input.accountId ?? mirrored!.id,
    accountId: input.accountId ?? null,
    contactId: input.contactId ?? null,
    opportunityId: input.opportunityId ?? null,
    title: input.subject,
    summary: input.body.slice(0, 200),
    direction: 'outbound',
    occurredAt: sentAt,
    sourceType: 'email',
    sourceId: mirrored!.id,
  });

  if (input.accountId) {
    await addTimelineEvent(ctx, {
      type: 'email_sent',
      subjectType: 'account',
      subjectId: input.accountId,
      accountId: input.accountId,
      opportunityId: input.opportunityId ?? null,
      contactId: input.contactId ?? null,
      title: `Sent: ${input.subject}`,
      body: input.body.slice(0, 400),
      occurredAt: sentAt,
      sourceType: 'email',
      sourceId: mirrored!.id,
    });
  }

  await record(ctx, {
    action: 'email.sent',
    resourceType: 'email_outbox',
    resourceId: outboxId,
    riskLevel: 'high',
    metadata: {
      to: input.to,
      cc: input.cc ?? [],
      subject: input.subject,
      provider: provider.name,
      delivered: provider.delivers,
    },
  });

  return { outboxId, delivered: provider.delivers, provider: provider.name, providerMessageId };
}
