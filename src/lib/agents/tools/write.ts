import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  emailOutbox,
  notes,
  opportunities,
  pipelineStages,
  tasks,
  type ApprovalPreview,
  type FieldChange,
} from '@/db/schema';
import { scope, scoped, ValidationError } from '@/server/context';
import { record, diff } from '@/server/audit';
import { addActivity, addTimelineEvent } from '@/server/memory/timeline';
import { defineTool, registerTool, type ToolResult } from '../registry';

/**
 * Write tools.
 *
 * Risk classes follow the product's safety model:
 *   MEDIUM — internal state changes (tasks, notes, field edits, stage moves).
 *            Configurable per workspace; approval on by default for agents.
 *   HIGH   — anything the customer sees or that destroys data (sending email,
 *            deleting, bulk changes). Always approval-gated by default.
 *
 * `draft_email` is deliberately MEDIUM and `send_email` HIGH: drafting is
 * useful and reversible, sending is neither. Every tool here defines a
 * `preview()` that renders the *exact* effect, because an approval screen that
 * paraphrases what will happen is not really an approval.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

registerTool(
  defineTool({
    name: 'create_task',
    description: 'Create a task assigned to a teammate, optionally linked to an account, deal or commitment.',
    input: z.object({
      title: z.string().min(3).max(200).describe('What needs doing.'),
      description: z.string().max(2000).optional(),
      dueInDays: z.number().int().min(0).max(365).optional().describe('Due date, in days from now.'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      assigneeId: z.string().optional().describe('User id to assign to. Defaults to the record owner.'),
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
      contactId: z.string().optional(),
      commitmentId: z.string().optional().describe('Link this task to a commitment it fulfils.'),
    }),
    permission: 'record:create',
    risk: 'medium',
    readOnly: false,
    async preview({ ctx }, input): Promise<ApprovalPreview> {
      const label = await describeLink(ctx, input);
      return {
        kind: 'text',
        body: [
          `Create task: "${input.title}"`,
          input.description ? `Details: ${input.description}` : null,
          `Priority: ${input.priority}`,
          input.dueInDays != null
            ? `Due: ${new Date(Date.now() + input.dueInDays * 86_400_000).toISOString().slice(0, 10)}`
            : 'No due date',
          label ? `Linked to: ${label}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const assigneeId = input.assigneeId ?? (await inferOwner(ctx, input)) ?? ctx.userId;

      const [task] = await ctx.db
        .insert(tasks)
        .values({
          workspaceId: ctx.workspaceId,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority,
          dueAt: input.dueInDays != null ? new Date(Date.now() + input.dueInDays * 86_400_000) : null,
          assigneeId: assigneeId ?? null,
          createdById: ctx.userId,
          createdByAgentId: ctx.actor.type === 'agent' ? ctx.actor.id : null,
          accountId: input.accountId ?? null,
          opportunityId: input.opportunityId ?? null,
          contactId: input.contactId ?? null,
          sourceType: input.commitmentId ? 'commitment' : null,
          sourceId: input.commitmentId ?? null,
        })
        .returning();

      if (input.commitmentId) {
        await ctx.db
          .update(commitments)
          .set({ taskId: task!.id })
          .where(and(scope(ctx, commitments), eq(commitments.id, input.commitmentId)));
      }

      await record(ctx, {
        action: 'task.created',
        resourceType: 'task',
        resourceId: task!.id,
        riskLevel: 'medium',
        metadata: { title: input.title, assigneeId },
      });

      return { summary: `Created task "${input.title}".`, data: { id: task!.id, title: task!.title } };
    },
  }),
);

registerTool(
  defineTool({
    name: 'add_note',
    description: 'Attach an internal note to a record. Notes are visible to the team but never to the customer.',
    input: z.object({
      body: z.string().min(3).max(8000).describe('The note text.'),
      subjectType: z.enum(['account', 'contact', 'opportunity', 'meeting']),
      subjectId: z.string(),
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
    }),
    permission: 'record:create',
    risk: 'medium',
    readOnly: false,
    async preview(_tctx, input): Promise<ApprovalPreview> {
      return { kind: 'text', body: `Add a note to ${input.subjectType} ${input.subjectId}:\n\n${input.body}` };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const [note] = await ctx.db
        .insert(notes)
        .values({
          workspaceId: ctx.workspaceId,
          authorId: ctx.userId,
          body: input.body,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          accountId: input.accountId ?? null,
          opportunityId: input.opportunityId ?? null,
        })
        .returning();

      await record(ctx, {
        action: 'note.created',
        resourceType: 'note',
        resourceId: note!.id,
        riskLevel: 'medium',
        metadata: { subjectType: input.subjectType, subjectId: input.subjectId },
      });

      return { summary: 'Note added.', data: { id: note!.id } };
    },
  }),
);

const UPDATABLE: Record<string, string[]> = {
  account: ['name', 'domain', 'website', 'industry', 'employeeCount', 'currentArr', 'description', 'lifecycleStage', 'tier', 'ownerId'],
  contact: ['firstName', 'lastName', 'email', 'phone', 'title', 'seniority', 'department', 'buyingRole', 'ownerId'],
  opportunity: ['name', 'value', 'probability', 'expectedCloseDate', 'ownerId', 'source', 'lossReason'],
};

registerTool(
  defineTool({
    name: 'update_record',
    description:
      'Update fields on an account, contact or opportunity. Only whitelisted business fields can be changed — AI-derived scores and memory are not editable through this tool.',
    input: z.object({
      recordType: z.enum(['account', 'contact', 'opportunity']),
      recordId: z.string(),
      updates: z
        .array(
          z.object({
            field: z.string().describe('Field name, e.g. "value" or "buyingRole".'),
            value: z.string().describe('New value as a string; it is coerced to the field type.'),
          }),
        )
        .min(1)
        .max(12),
      reason: z.string().max(400).optional().describe('Why this change is being made.'),
    }),
    permission: 'record:update',
    risk: 'medium',
    readOnly: false,
    async preview({ ctx }, input): Promise<ApprovalPreview> {
      const { current, changes, label } = await planUpdate(ctx, input);
      return {
        kind: 'record_diff',
        recordType: input.recordType,
        recordId: input.recordId,
        recordLabel: label,
        changes,
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const { table, current, changes, patch, label } = await planUpdate(ctx, input);
      if (changes.length === 0) {
        return { summary: 'No changes — the record already holds those values.', data: { changed: 0 } };
      }

      await ctx.db
        .update(table)
        .set(patch)
        .where(and(scope(ctx, table), eq(table.id, input.recordId)));

      await record(ctx, {
        action: `${input.recordType}.updated`,
        resourceType: input.recordType,
        resourceId: input.recordId,
        riskLevel: 'medium',
        changes: diff(current as Record<string, unknown>, patch),
        metadata: { reason: input.reason },
      });

      const accountId =
        input.recordType === 'account'
          ? input.recordId
          : ((current as { accountId?: string | null }).accountId ?? null);

      if (accountId) {
        await addTimelineEvent(ctx, {
          type: 'field_updated',
          subjectType: input.recordType === 'opportunity' ? 'opportunity' : 'account',
          subjectId: input.recordId,
          accountId,
          opportunityId: input.recordType === 'opportunity' ? input.recordId : null,
          title: `Updated ${changes.map((c) => c.label).join(', ')} on ${label}`,
          body: input.reason ?? null,
          metadata: { changes },
        });
      }

      return {
        summary: `Updated ${changes.length} field${changes.length === 1 ? '' : 's'} on ${label}.`,
        data: { changes },
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'change_pipeline_stage',
    description: 'Move a deal to a different pipeline stage.',
    input: z.object({
      opportunityId: z.string(),
      stageName: z.string().describe('Target stage name, e.g. "Negotiation".'),
      reason: z.string().max(400).describe('Evidence-backed reason for the move.'),
    }),
    permission: 'record:update',
    risk: 'medium',
    readOnly: false,
    async preview({ ctx }, input): Promise<ApprovalPreview> {
      const { opp, from, to } = await planStageChange(ctx, input);
      return {
        kind: 'record_diff',
        recordType: 'opportunity',
        recordId: input.opportunityId,
        recordLabel: opp.name,
        changes: [{ field: 'stage', label: 'Pipeline stage', from: from?.name ?? null, to: to.name }],
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const { opp, from, to } = await planStageChange(ctx, input);
      if (from?.id === to.id) {
        return { summary: `${opp.name} is already in ${to.name}.`, data: { changed: false } };
      }

      await ctx.db
        .update(opportunities)
        .set({
          stageId: to.id,
          stageEnteredAt: new Date(),
          probability: to.probability,
          status: to.type === 'open' ? 'open' : to.type,
          closedAt: to.type === 'open' ? null : new Date(),
        })
        .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)));

      await record(ctx, {
        action: 'opportunity.stage_changed',
        resourceType: 'opportunity',
        resourceId: input.opportunityId,
        riskLevel: 'medium',
        changes: { stage: { from: from?.name ?? null, to: to.name } },
        metadata: { reason: input.reason },
      });

      await addTimelineEvent(ctx, {
        type: 'stage_changed',
        subjectType: 'opportunity',
        subjectId: input.opportunityId,
        accountId: opp.accountId,
        opportunityId: input.opportunityId,
        title: `Stage: ${from?.name ?? 'none'} → ${to.name}`,
        body: input.reason,
        importance: 4,
      });

      await addActivity(ctx, {
        type: 'stage_change',
        subjectType: 'opportunity',
        subjectId: input.opportunityId,
        accountId: opp.accountId,
        opportunityId: input.opportunityId,
        title: `Moved to ${to.name}`,
        summary: input.reason,
        direction: 'internal',
        occurredAt: new Date(),
      });

      return { summary: `Moved ${opp.name} to ${to.name}.`, data: { from: from?.name, to: to.name } };
    },
  }),
);

registerTool(
  defineTool({
    name: 'draft_email',
    description:
      'Compose an email and save it as a draft. This does NOT send — use send_email for that, which requires human approval.',
    input: z.object({
      to: z.array(z.string()).min(1).max(20).describe('Recipient email addresses.'),
      cc: z.array(z.string()).max(20).optional(),
      subject: z.string().min(1).max(300),
      body: z.string().min(10).max(20_000).describe('Plain-text body.'),
      accountId: z.string().optional(),
      contactId: z.string().optional(),
      opportunityId: z.string().optional(),
    }),
    permission: 'email:draft',
    risk: 'medium',
    readOnly: false,
    async preview(_tctx, input): Promise<ApprovalPreview> {
      return { kind: 'email', to: input.to, cc: input.cc, subject: input.subject, body: input.body };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      assertEmails([...input.to, ...(input.cc ?? [])]);

      const [draft] = await ctx.db
        .insert(emailOutbox)
        .values({
          workspaceId: ctx.workspaceId,
          toEmails: input.to,
          ccEmails: input.cc ?? [],
          fromEmail: 'workspace',
          subject: input.subject,
          body: input.body,
          status: 'draft',
          accountId: input.accountId ?? null,
          contactId: input.contactId ?? null,
          opportunityId: input.opportunityId ?? null,
          createdById: ctx.userId,
          runId: ctx.runId ?? null,
        })
        .returning();

      await record(ctx, {
        action: 'email.drafted',
        resourceType: 'email_outbox',
        resourceId: draft!.id,
        riskLevel: 'medium',
        metadata: { to: input.to, subject: input.subject },
      });

      return {
        summary: `Drafted "${input.subject}" to ${input.to.join(', ')}. Not sent — awaiting review.`,
        data: { draftId: draft!.id, subject: input.subject, to: input.to },
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'send_email',
    description:
      'Send an email to a customer. HIGH RISK: always requires explicit human approval unless an admin has granted this agent autonomous sending.',
    input: z.object({
      draftId: z.string().optional().describe('Send an existing draft by id.'),
      to: z.array(z.string()).max(20).optional(),
      cc: z.array(z.string()).max(20).optional(),
      subject: z.string().max(300).optional(),
      body: z.string().max(20_000).optional(),
      accountId: z.string().optional(),
      contactId: z.string().optional(),
      opportunityId: z.string().optional(),
    }),
    permission: 'email:send',
    risk: 'high',
    readOnly: false,
    async preview({ ctx }, input): Promise<ApprovalPreview> {
      const message = await resolveOutgoing(ctx, input);
      return { kind: 'email', to: message.to, cc: message.cc, subject: message.subject, body: message.body };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const message = await resolveOutgoing(ctx, input);
      assertEmails([...message.to, ...message.cc]);

      const { sendEmail } = await import('@/server/email/send');
      const result = await sendEmail(ctx, {
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        body: message.body,
        draftId: input.draftId,
        accountId: input.accountId ?? message.accountId,
        contactId: input.contactId ?? message.contactId,
        opportunityId: input.opportunityId ?? message.opportunityId,
      });

      return {
        summary: result.delivered
          ? `Sent "${message.subject}" to ${message.to.join(', ')}.`
          : `Queued "${message.subject}" (provider: ${result.provider}).`,
        data: result,
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'create_contact',
    description: 'Create a new contact.',
    input: z.object({
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(80),
      email: z.string().max(200).optional(),
      title: z.string().max(140).optional(),
      accountId: z.string().optional(),
      buyingRole: z
        .enum(['champion', 'decision_maker', 'economic_buyer', 'technical_evaluator', 'blocker', 'influencer', 'end_user', 'unknown'])
        .optional(),
    }),
    permission: 'record:create',
    risk: 'medium',
    readOnly: false,
    async preview(_tctx, input): Promise<ApprovalPreview> {
      return {
        kind: 'text',
        body: `Create contact: ${input.firstName} ${input.lastName}${input.title ? `, ${input.title}` : ''}${
          input.email ? ` <${input.email}>` : ''
        }`,
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      if (input.email) assertEmails([input.email]);
      const [contact] = await ctx.db
        .insert(contacts)
        .values({
          workspaceId: ctx.workspaceId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          title: input.title ?? null,
          accountId: input.accountId ?? null,
          buyingRole: input.buyingRole ?? 'unknown',
          ownerId: ctx.userId,
        })
        .returning();

      await record(ctx, {
        action: 'contact.created',
        resourceType: 'contact',
        resourceId: contact!.id,
        riskLevel: 'medium',
        metadata: { name: `${input.firstName} ${input.lastName}` },
      });

      return { summary: `Created contact ${input.firstName} ${input.lastName}.`, data: { id: contact!.id } };
    },
  }),
);

registerTool(
  defineTool({
    name: 'create_account',
    description: 'Create a new account (company).',
    input: z.object({
      name: z.string().min(2).max(200),
      domain: z.string().max(200).optional(),
      industry: z.string().max(120).optional(),
      employeeCount: z.number().int().min(0).max(10_000_000).optional(),
      description: z.string().max(2000).optional(),
    }),
    permission: 'record:create',
    risk: 'medium',
    readOnly: false,
    async preview(_tctx, input): Promise<ApprovalPreview> {
      return {
        kind: 'text',
        body: `Create account: ${input.name}${input.domain ? ` (${input.domain})` : ''}${
          input.industry ? ` — ${input.industry}` : ''
        }`,
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const [account] = await ctx.db
        .insert(accounts)
        .values({
          workspaceId: ctx.workspaceId,
          name: input.name,
          domain: input.domain?.toLowerCase() ?? null,
          industry: input.industry ?? null,
          employeeCount: input.employeeCount ?? null,
          description: input.description ?? null,
          ownerId: ctx.userId,
        })
        .returning();

      await record(ctx, {
        action: 'account.created',
        resourceType: 'account',
        resourceId: account!.id,
        riskLevel: 'medium',
        metadata: { name: input.name },
      });

      return { summary: `Created account ${input.name}.`, data: { id: account!.id } };
    },
  }),
);

registerTool(
  defineTool({
    name: 'create_opportunity',
    description: 'Create a new deal against an existing account.',
    input: z.object({
      accountId: z.string(),
      name: z.string().min(2).max(200),
      value: z.number().min(0).max(1_000_000_000),
      stageName: z.string().optional().describe('Starting stage; defaults to the first stage.'),
      expectedCloseInDays: z.number().int().min(0).max(730).optional(),
    }),
    permission: 'record:create',
    risk: 'medium',
    readOnly: false,
    async preview({ ctx }, input): Promise<ApprovalPreview> {
      const [account] = await ctx.db
        .select({ name: accounts.name })
        .from(accounts)
        .where(and(scope(ctx, accounts), eq(accounts.id, input.accountId)))
        .limit(1);
      return {
        kind: 'text',
        body: `Create opportunity "${input.name}" worth $${input.value.toLocaleString()} on ${account?.name ?? input.accountId}.`,
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const stages = await ctx.db
        .select()
        .from(pipelineStages)
        .where(scope(ctx, pipelineStages))
        .orderBy(pipelineStages.position);

      const stage = input.stageName
        ? stages.find((s) => s.name.toLowerCase() === input.stageName!.toLowerCase())
        : stages[0];
      if (!stage) throw new ValidationError('No pipeline stage available.');

      const [opp] = await ctx.db
        .insert(opportunities)
        .values({
          workspaceId: ctx.workspaceId,
          accountId: input.accountId,
          pipelineId: stage.pipelineId,
          stageId: stage.id,
          name: input.name,
          value: input.value,
          probability: stage.probability,
          ownerId: ctx.userId,
          expectedCloseDate:
            input.expectedCloseInDays != null
              ? new Date(Date.now() + input.expectedCloseInDays * 86_400_000)
              : null,
        })
        .returning();

      await record(ctx, {
        action: 'opportunity.created',
        resourceType: 'opportunity',
        resourceId: opp!.id,
        riskLevel: 'medium',
        metadata: { name: input.name, value: input.value },
      });

      return { summary: `Created opportunity "${input.name}".`, data: { id: opp!.id } };
    },
  }),
);

registerTool(
  defineTool({
    name: 'bulk_update_stage',
    description:
      'Move several deals to a stage at once. HIGH RISK because a mistake affects many records — always previewed item by item.',
    input: z.object({
      opportunityIds: z.array(z.string()).min(1).max(100),
      stageName: z.string(),
      reason: z.string().max(400),
    }),
    permission: 'record:bulk_update',
    risk: 'high',
    readOnly: false,
    async preview({ ctx }, input): Promise<ApprovalPreview> {
      const rows = await ctx.db
        .select({ id: opportunities.id, name: opportunities.name, value: opportunities.value, stage: pipelineStages.name })
        .from(opportunities)
        .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
        .where(scoped(ctx, opportunities, inArray(opportunities.id, input.opportunityIds)));

      return {
        kind: 'bulk',
        description: `Move ${rows.length} deals to "${input.stageName}". ${input.reason}`,
        itemCount: rows.length,
        items: rows.map((r) => ({
          label: r.name,
          detail: `$${r.value.toLocaleString()} · ${r.stage} → ${input.stageName}`,
        })),
      };
    },
    async execute({ ctx }, input): Promise<ToolResult> {
      const [target] = await ctx.db
        .select()
        .from(pipelineStages)
        .where(scoped(ctx, pipelineStages, eq(pipelineStages.name, input.stageName)))
        .limit(1);
      if (!target) throw new ValidationError(`No pipeline stage named "${input.stageName}".`);

      const rows = await ctx.db
        .select({ id: opportunities.id, name: opportunities.name, accountId: opportunities.accountId })
        .from(opportunities)
        .where(scoped(ctx, opportunities, inArray(opportunities.id, input.opportunityIds)));

      for (const row of rows) {
        await ctx.db
          .update(opportunities)
          .set({ stageId: target.id, stageEnteredAt: new Date(), probability: target.probability })
          .where(and(scope(ctx, opportunities), eq(opportunities.id, row.id)));

        await addTimelineEvent(ctx, {
          type: 'stage_changed',
          subjectType: 'opportunity',
          subjectId: row.id,
          accountId: row.accountId,
          opportunityId: row.id,
          title: `Bulk move to ${target.name}`,
          body: input.reason,
          importance: 3,
        });
      }

      await record(ctx, {
        action: 'opportunity.bulk_stage_changed',
        resourceType: 'opportunity',
        riskLevel: 'high',
        metadata: { count: rows.length, stage: target.name, reason: input.reason, ids: rows.map((r) => r.id) },
      });

      return { summary: `Moved ${rows.length} deals to ${target.name}.`, data: { count: rows.length } };
    },
  }),
);

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function assertEmails(addresses: string[]): void {
  const invalid = addresses.filter((a) => !EMAIL_RE.test(a.trim()));
  if (invalid.length > 0) {
    throw new ValidationError(`Invalid email address${invalid.length === 1 ? '' : 'es'}: ${invalid.join(', ')}`);
  }
}

type UpdateInput = {
  recordType: 'account' | 'contact' | 'opportunity';
  recordId: string;
  updates: { field: string; value: string }[];
  reason?: string;
};

async function planUpdate(ctx: import('@/server/context').Ctx, input: UpdateInput) {
  const table =
    input.recordType === 'account' ? accounts : input.recordType === 'contact' ? contacts : opportunities;

  const [current] = await ctx.db
    .select()
    .from(table)
    .where(and(scope(ctx, table), eq(table.id, input.recordId)))
    .limit(1);
  if (!current) throw new ValidationError(`No ${input.recordType} with id ${input.recordId} in this workspace.`);

  const allowed = UPDATABLE[input.recordType] ?? [];
  const patch: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  const row = current as Record<string, unknown>;

  for (const update of input.updates) {
    if (!allowed.includes(update.field)) {
      // Refusing unknown fields is what stops a model from writing to
      // health_score, memory_summary or workspace_id.
      throw new ValidationError(
        `Field "${update.field}" is not editable on ${input.recordType}. Editable: ${allowed.join(', ')}.`,
      );
    }
    const coerced = coerceField(update.field, update.value);
    const before = row[update.field];
    const same =
      before instanceof Date && coerced instanceof Date
        ? before.getTime() === coerced.getTime()
        : String(before ?? '') === String(coerced ?? '');
    if (same) continue;

    patch[update.field] = coerced;
    changes.push({ field: update.field, label: humanise(update.field), from: before ?? null, to: coerced });
  }

  const label =
    input.recordType === 'contact'
      ? `${row['firstName']} ${row['lastName']}`
      : String(row['name'] ?? input.recordId);

  return { table, current, patch, changes, label };
}

const NUMERIC = new Set(['value', 'probability', 'employeeCount', 'currentArr', 'annualRevenue']);
const DATES = new Set(['expectedCloseDate']);

function coerceField(field: string, value: string): unknown {
  if (NUMERIC.has(field)) {
    const n = Number(value.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) throw new ValidationError(`"${value}" is not a number for field ${field}.`);
    return n;
  }
  if (DATES.has(field)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new ValidationError(`"${value}" is not a date for field ${field}.`);
    return d;
  }
  return value;
}

function humanise(field: string): string {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

async function planStageChange(
  ctx: import('@/server/context').Ctx,
  input: { opportunityId: string; stageName: string },
) {
  const [opp] = await ctx.db
    .select()
    .from(opportunities)
    .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)))
    .limit(1);
  if (!opp) throw new ValidationError(`No opportunity with id ${input.opportunityId} in this workspace.`);

  const stages = await ctx.db
    .select()
    .from(pipelineStages)
    .where(scoped(ctx, pipelineStages, eq(pipelineStages.pipelineId, opp.pipelineId)))
    .orderBy(pipelineStages.position);

  const to = stages.find((s) => s.name.toLowerCase() === input.stageName.toLowerCase());
  if (!to) {
    throw new ValidationError(
      `No stage named "${input.stageName}" in this pipeline. Available: ${stages.map((s) => s.name).join(', ')}.`,
    );
  }
  return { opp, from: stages.find((s) => s.id === opp.stageId), to };
}

async function resolveOutgoing(
  ctx: import('@/server/context').Ctx,
  input: {
    draftId?: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    body?: string;
  },
) {
  if (input.draftId) {
    const [draft] = await ctx.db
      .select()
      .from(emailOutbox)
      .where(and(scope(ctx, emailOutbox), eq(emailOutbox.id, input.draftId)))
      .limit(1);
    if (!draft) throw new ValidationError(`No draft with id ${input.draftId}.`);
    if (draft.status === 'sent') throw new ValidationError('That draft has already been sent.');
    return {
      to: draft.toEmails,
      cc: draft.ccEmails,
      subject: draft.subject,
      body: draft.body,
      accountId: draft.accountId ?? undefined,
      contactId: draft.contactId ?? undefined,
      opportunityId: draft.opportunityId ?? undefined,
    };
  }

  if (!input.to?.length || !input.subject || !input.body) {
    throw new ValidationError('send_email needs either a draftId, or to + subject + body.');
  }
  return {
    to: input.to,
    cc: input.cc ?? [],
    subject: input.subject,
    body: input.body,
    accountId: undefined,
    contactId: undefined,
    opportunityId: undefined,
  };
}

async function inferOwner(
  ctx: import('@/server/context').Ctx,
  input: { opportunityId?: string; accountId?: string },
): Promise<string | null> {
  if (input.opportunityId) {
    const [opp] = await ctx.db
      .select({ ownerId: opportunities.ownerId })
      .from(opportunities)
      .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)))
      .limit(1);
    if (opp?.ownerId) return opp.ownerId;
  }
  if (input.accountId) {
    const [account] = await ctx.db
      .select({ ownerId: accounts.ownerId })
      .from(accounts)
      .where(and(scope(ctx, accounts), eq(accounts.id, input.accountId)))
      .limit(1);
    if (account?.ownerId) return account.ownerId;
  }
  return null;
}

async function describeLink(
  ctx: import('@/server/context').Ctx,
  input: { accountId?: string; opportunityId?: string },
): Promise<string | null> {
  if (input.opportunityId) {
    const [opp] = await ctx.db
      .select({ name: opportunities.name })
      .from(opportunities)
      .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)))
      .limit(1);
    if (opp) return `deal "${opp.name}"`;
  }
  if (input.accountId) {
    const [account] = await ctx.db
      .select({ name: accounts.name })
      .from(accounts)
      .where(and(scope(ctx, accounts), eq(accounts.id, input.accountId)))
      .limit(1);
    if (account) return `account "${account.name}"`;
  }
  return null;
}
