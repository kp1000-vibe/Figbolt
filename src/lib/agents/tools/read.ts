import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  emails,
  knowledgeChunks,
  knowledgeDocuments,
  meetings,
  objections,
  opportunities,
  pipelineStages,
  productSignals,
  tasks,
  transcripts,
  users,
  type SourceRef,
} from '@/db/schema';
import { scope, scoped } from '@/server/context';
import { search } from '@/server/retrieval/search';
import { getRecentActivity, getTimeline } from '@/server/memory/timeline';
import { currentFacts, displayValue, factHistory } from '@/server/memory/facts';
import { scoreOpportunityHealth } from '@/server/intelligence/health';
import { defineTool, registerTool, type ToolResult } from '../registry';

/**
 * Read tools.
 *
 * All LOW risk and read-only: they cannot change anything, so they execute
 * without approval. Every one is workspace-scoped through `scope()`, so an
 * agent cannot read across tenants even if it is handed a foreign id.
 *
 * Results are deliberately compact — the model gets ids, labels and the fields
 * it needs to decide, not entire row dumps that would burn the context window.
 */

const limitField = z.number().int().min(1).max(50).default(10).describe('Maximum results (1-50).');

registerTool(
  defineTool({
    name: 'search_accounts',
    description:
      'Find accounts (companies) by name, industry, owner, health or activity. Use when you need to identify companies matching criteria.',
    input: z.object({
      query: z.string().optional().describe('Name or keyword to match.'),
      industry: z.string().optional().describe('Exact industry to filter by.'),
      lifecycleStage: z.enum(['prospect', 'opportunity', 'customer', 'churned']).optional(),
      minHealth: z.number().int().min(0).max(100).optional().describe('Minimum health score.'),
      maxHealth: z.number().int().min(0).max(100).optional().describe('Maximum health score.'),
      inactiveDays: z.number().int().min(1).max(365).optional().describe('No interaction for at least this many days.'),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const rows = await ctx.db
        .select({
          id: accounts.id,
          name: accounts.name,
          industry: accounts.industry,
          lifecycleStage: accounts.lifecycleStage,
          healthScore: accounts.healthScore,
          currentArr: accounts.currentArr,
          lastInteractionAt: accounts.lastInteractionAt,
          ownerName: users.name,
        })
        .from(accounts)
        .leftJoin(users, eq(users.id, accounts.ownerId))
        .where(
          scoped(
            ctx,
            accounts,
            input.query ? ilike(accounts.name, `%${input.query}%`) : undefined,
            input.industry ? eq(accounts.industry, input.industry) : undefined,
            input.lifecycleStage ? eq(accounts.lifecycleStage, input.lifecycleStage) : undefined,
            input.minHealth != null ? gte(accounts.healthScore, input.minHealth) : undefined,
            input.maxHealth != null ? lte(accounts.healthScore, input.maxHealth) : undefined,
            input.inactiveDays
              ? or(
                  sql`${accounts.lastInteractionAt} IS NULL`,
                  lt(accounts.lastInteractionAt, new Date(Date.now() - input.inactiveDays * 86_400_000)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(accounts.currentArr), accounts.name)
        .limit(input.limit);

      return {
        summary: `${rows.length} account${rows.length === 1 ? '' : 's'} matched.`,
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          industry: r.industry,
          stage: r.lifecycleStage,
          health: r.healthScore,
          arr: r.currentArr,
          owner: r.ownerName,
          daysSinceContact: r.lastInteractionAt
            ? Math.floor((Date.now() - r.lastInteractionAt.getTime()) / 86_400_000)
            : null,
        })),
        sources: rows.map((r) => ({ type: 'account' as const, id: r.id, label: r.name })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_contacts',
    description: 'Find people by name, email, title, buying role or account.',
    input: z.object({
      query: z.string().optional().describe('Name, email or title keyword.'),
      accountId: z.string().optional().describe('Restrict to one account.'),
      buyingRole: z
        .enum(['champion', 'decision_maker', 'economic_buyer', 'technical_evaluator', 'blocker', 'influencer', 'end_user'])
        .optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const rows = await ctx.db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          title: contacts.title,
          buyingRole: contacts.buyingRole,
          accountName: accounts.name,
          accountId: contacts.accountId,
          lastInteractionAt: contacts.lastInteractionAt,
        })
        .from(contacts)
        .leftJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(
          scoped(
            ctx,
            contacts,
            input.query
              ? or(
                  ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, `%${input.query}%`),
                  ilike(contacts.email, `%${input.query}%`),
                  ilike(contacts.title, `%${input.query}%`),
                )
              : undefined,
            input.accountId ? eq(contacts.accountId, input.accountId) : undefined,
            input.buyingRole ? eq(contacts.buyingRole, input.buyingRole) : undefined,
          ),
        )
        .limit(input.limit);

      return {
        summary: `${rows.length} contact${rows.length === 1 ? '' : 's'} matched.`,
        data: rows.map((r) => ({
          id: r.id,
          name: `${r.firstName} ${r.lastName}`,
          email: r.email,
          title: r.title,
          role: r.buyingRole,
          account: r.accountName,
          accountId: r.accountId,
        })),
        sources: rows.map((r) => ({
          type: 'contact' as const,
          id: r.id,
          label: `${r.firstName} ${r.lastName}`,
        })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_opportunities',
    description:
      'Find deals by value, stage, status, owner, close date or inactivity. The primary tool for pipeline questions.',
    input: z.object({
      query: z.string().optional().describe('Deal or account name keyword.'),
      accountId: z.string().optional(),
      status: z.enum(['open', 'won', 'lost']).optional(),
      stageName: z.string().optional().describe('Pipeline stage name, e.g. "Negotiation".'),
      minValue: z.number().min(0).optional().describe('Minimum deal value.'),
      maxValue: z.number().min(0).optional(),
      inactiveDays: z.number().int().min(1).max(365).optional().describe('No customer activity for at least this many days.'),
      closingWithinDays: z.number().int().min(1).max(365).optional(),
      maxHealth: z.number().int().min(0).max(100).optional().describe('At-risk filter: health at or below this.'),
      ownerId: z.string().optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const rows = await ctx.db
        .select({
          id: opportunities.id,
          name: opportunities.name,
          value: opportunities.value,
          status: opportunities.status,
          healthScore: opportunities.healthScore,
          expectedCloseDate: opportunities.expectedCloseDate,
          lastInteractionAt: opportunities.lastInteractionAt,
          stageEnteredAt: opportunities.stageEnteredAt,
          stageName: pipelineStages.name,
          accountName: accounts.name,
          accountId: opportunities.accountId,
          ownerName: users.name,
          ownerId: opportunities.ownerId,
        })
        .from(opportunities)
        .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
        .leftJoin(users, eq(users.id, opportunities.ownerId))
        .where(
          scoped(
            ctx,
            opportunities,
            input.query
              ? or(ilike(opportunities.name, `%${input.query}%`), ilike(accounts.name, `%${input.query}%`))
              : undefined,
            input.accountId ? eq(opportunities.accountId, input.accountId) : undefined,
            input.status ? eq(opportunities.status, input.status) : undefined,
            input.stageName ? ilike(pipelineStages.name, input.stageName) : undefined,
            input.minValue != null ? gte(opportunities.value, input.minValue) : undefined,
            input.maxValue != null ? lte(opportunities.value, input.maxValue) : undefined,
            input.ownerId ? eq(opportunities.ownerId, input.ownerId) : undefined,
            input.maxHealth != null ? lte(opportunities.healthScore, input.maxHealth) : undefined,
            input.inactiveDays
              ? or(
                  sql`${opportunities.lastInteractionAt} IS NULL`,
                  lt(opportunities.lastInteractionAt, new Date(Date.now() - input.inactiveDays * 86_400_000)),
                )
              : undefined,
            input.closingWithinDays
              ? lte(opportunities.expectedCloseDate, new Date(Date.now() + input.closingWithinDays * 86_400_000))
              : undefined,
          ),
        )
        .orderBy(desc(opportunities.value))
        .limit(input.limit);

      return {
        summary: `${rows.length} opportunit${rows.length === 1 ? 'y' : 'ies'} matched, worth $${rows
          .reduce((s, r) => s + r.value, 0)
          .toLocaleString()} in total.`,
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          account: r.accountName,
          accountId: r.accountId,
          value: r.value,
          stage: r.stageName,
          status: r.status,
          health: r.healthScore,
          owner: r.ownerName,
          ownerId: r.ownerId,
          expectedClose: r.expectedCloseDate?.toISOString().slice(0, 10) ?? null,
          daysSinceContact: r.lastInteractionAt
            ? Math.floor((Date.now() - r.lastInteractionAt.getTime()) / 86_400_000)
            : null,
          daysInStage: Math.floor((Date.now() - r.stageEnteredAt.getTime()) / 86_400_000),
        })),
        sources: rows.map((r) => ({ type: 'opportunity' as const, id: r.id, label: r.name })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'get_account',
    description: 'Full detail for one account: fields, AI memory summary, health rationale, known facts.',
    input: z.object({ accountId: z.string().describe('The account id.') }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const [account] = await ctx.db
        .select()
        .from(accounts)
        .where(and(scope(ctx, accounts), eq(accounts.id, input.accountId)))
        .limit(1);
      if (!account) return { summary: 'No such account in this workspace.', data: null };

      const [facts, people, deals] = await Promise.all([
        currentFacts(ctx, 'account', account.id),
        ctx.db
          .select({
            id: contacts.id,
            name: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`,
            title: contacts.title,
            buyingRole: contacts.buyingRole,
          })
          .from(contacts)
          .where(scoped(ctx, contacts, eq(contacts.accountId, account.id)))
          .limit(20),
        ctx.db
          .select({
            id: opportunities.id,
            name: opportunities.name,
            value: opportunities.value,
            status: opportunities.status,
            health: opportunities.healthScore,
          })
          .from(opportunities)
          .where(scoped(ctx, opportunities, eq(opportunities.accountId, account.id)))
          .limit(20),
      ]);

      return {
        summary: `${account.name} — ${account.lifecycleStage}, health ${account.healthScore ?? 'unscored'}, ${deals.length} deals, ${people.length} contacts.`,
        data: {
          id: account.id,
          name: account.name,
          domain: account.domain,
          industry: account.industry,
          employees: account.employeeCount,
          arr: account.currentArr,
          lifecycleStage: account.lifecycleStage,
          health: account.healthScore,
          healthReasons: {
            positives: account.healthRationale?.positives.map((p) => p.label) ?? [],
            risks: account.healthRationale?.risks.map((r) => r.label) ?? [],
          },
          memory: account.memorySummary,
          facts: facts.map((f) => ({ label: f.label, value: displayValue(f), confidence: f.confidence })),
          contacts: people,
          opportunities: deals,
          lastInteraction: account.lastInteractionAt?.toISOString().slice(0, 10) ?? null,
        },
        sources: [{ type: 'account', id: account.id, label: account.name }],
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'get_opportunity',
    description:
      'Full detail for one deal: value, stage, stakeholders, objections, commitments, health rationale and AI summary.',
    input: z.object({ opportunityId: z.string().describe('The opportunity id.') }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const [opp] = await ctx.db
        .select()
        .from(opportunities)
        .where(and(scope(ctx, opportunities), eq(opportunities.id, input.opportunityId)))
        .limit(1);
      if (!opp) return { summary: 'No such opportunity in this workspace.', data: null };

      const [[account], [stage], objs, cmts, facts] = await Promise.all([
        ctx.db.select().from(accounts).where(and(scope(ctx, accounts), eq(accounts.id, opp.accountId))).limit(1),
        ctx.db.select().from(pipelineStages).where(and(scope(ctx, pipelineStages), eq(pipelineStages.id, opp.stageId))).limit(1),
        ctx.db
          .select()
          .from(objections)
          .where(scoped(ctx, objections, eq(objections.opportunityId, opp.id), inArray(objections.status, ['open', 'addressed'])))
          .limit(15),
        ctx.db
          .select()
          .from(commitments)
          .where(scoped(ctx, commitments, eq(commitments.opportunityId, opp.id), inArray(commitments.status, ['open', 'overdue'])))
          .limit(15),
        currentFacts(ctx, 'opportunity', opp.id),
      ]);

      return {
        summary: `${opp.name} — $${opp.value.toLocaleString()} in ${stage?.name}, health ${opp.healthScore ?? 'unscored'}.`,
        data: {
          id: opp.id,
          name: opp.name,
          account: account?.name,
          accountId: opp.accountId,
          value: opp.value,
          stage: stage?.name,
          status: opp.status,
          health: opp.healthScore,
          healthReasons: {
            positives: opp.healthRationale?.positives.map((p) => `${p.label}${p.detail ? ` — ${p.detail}` : ''}`) ?? [],
            risks: opp.healthRationale?.risks.map((r) => `${r.label}${r.detail ? ` — ${r.detail}` : ''}`) ?? [],
          },
          memory: opp.memorySummary,
          objections: objs.map((o) => ({ id: o.id, category: o.category, summary: o.summary, severity: o.severity, status: o.status, quote: o.sourceQuote })),
          openCommitments: cmts.map((c) => ({
            id: c.id,
            description: c.description,
            direction: c.direction,
            owner: c.ownerLabel,
            dueAt: c.dueAt?.toISOString().slice(0, 10) ?? null,
            overdue: Boolean(c.dueAt && c.dueAt.getTime() < Date.now()),
          })),
          facts: facts.map((f) => ({ label: f.label, value: displayValue(f), confidence: f.confidence })),
          expectedClose: opp.expectedCloseDate?.toISOString().slice(0, 10) ?? null,
          daysSinceContact: opp.lastInteractionAt
            ? Math.floor((Date.now() - opp.lastInteractionAt.getTime()) / 86_400_000)
            : null,
        },
        sources: [{ type: 'opportunity', id: opp.id, label: opp.name }],
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'get_contact',
    description: 'Full detail for one person, including their AI memory summary.',
    input: z.object({ contactId: z.string().describe('The contact id.') }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const [contact] = await ctx.db
        .select()
        .from(contacts)
        .where(and(scope(ctx, contacts), eq(contacts.id, input.contactId)))
        .limit(1);
      if (!contact) return { summary: 'No such contact in this workspace.', data: null };

      const name = `${contact.firstName} ${contact.lastName}`;
      return {
        summary: `${name}${contact.title ? ` — ${contact.title}` : ''}.`,
        data: {
          id: contact.id,
          name,
          email: contact.email,
          title: contact.title,
          buyingRole: contact.buyingRole,
          accountId: contact.accountId,
          memory: contact.memorySummary,
          lastInteraction: contact.lastInteractionAt?.toISOString().slice(0, 10) ?? null,
        },
        sources: [{ type: 'contact', id: contact.id, label: name }],
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'get_recent_activity',
    description:
      'Chronological activity and timeline events for an account, deal or contact. Use to answer "what happened recently".',
    input: z.object({
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
      contactId: z.string().optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const rows = await getRecentActivity(ctx, { ...input, limit: input.limit });
      const timelineEvents =
        input.accountId || input.opportunityId
          ? await getTimeline(
              ctx,
              input.opportunityId ? 'opportunity' : 'account',
              (input.opportunityId ?? input.accountId)!,
              { limit: input.limit, minImportance: 3 },
            )
          : [];

      return {
        summary: `${rows.length} activities and ${timelineEvents.length} significant timeline events.`,
        data: {
          activities: rows.map((a) => ({
            type: a.type,
            title: a.title,
            summary: a.summary,
            direction: a.direction,
            when: a.occurredAt.toISOString().slice(0, 10),
            sourceType: a.sourceType,
            sourceId: a.sourceId,
          })),
          significantEvents: timelineEvents.map((e) => ({
            type: e.type,
            title: e.title,
            body: e.body,
            when: e.occurredAt.toISOString().slice(0, 10),
            importance: e.importance,
          })),
        },
        sources: rows
          .filter((a) => a.sourceType && a.sourceId)
          .slice(0, 8)
          .map((a) => ({
            type: a.sourceType as SourceRef['type'],
            id: a.sourceId!,
            label: a.title,
            occurredAt: a.occurredAt.toISOString(),
          })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_emails',
    description: 'Full-text and semantic search across email. Returns matching messages with their content.',
    input: z.object({
      query: z.string().describe('What to search for.'),
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
      sinceDays: z.number().int().min(1).max(730).optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const results = await search(ctx, {
        query: input.query,
        scopes: ['emails'],
        accountId: input.accountId,
        opportunityId: input.opportunityId,
        sinceDays: input.sinceDays ?? 0,
        limit: input.limit,
      });
      return {
        summary: `${results.length} email${results.length === 1 ? '' : 's'} matched "${input.query}".`,
        data: results.map((r) => ({
          id: r.ref.id,
          label: r.ref.label,
          when: r.ref.occurredAt?.slice(0, 10),
          excerpt: r.content.slice(0, 900),
        })),
        sources: results.map((r) => r.ref),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_meetings',
    description: 'Search meetings and their AI summaries.',
    input: z.object({
      query: z.string().describe('What to search for.'),
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
      sinceDays: z.number().int().min(1).max(730).optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const results = await search(ctx, {
        query: input.query,
        scopes: ['meetings'],
        accountId: input.accountId,
        opportunityId: input.opportunityId,
        sinceDays: input.sinceDays ?? 0,
        limit: input.limit,
      });
      return {
        summary: `${results.length} meeting${results.length === 1 ? '' : 's'} matched.`,
        data: results.map((r) => ({
          id: r.ref.id,
          label: r.ref.label,
          when: r.ref.occurredAt?.slice(0, 10),
          excerpt: r.content.slice(0, 900),
        })),
        sources: results.map((r) => r.ref),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_transcripts',
    description:
      'Search what was actually said in meetings. Use when you need the customer\'s own words rather than a summary.',
    input: z.object({
      query: z.string().describe('What to search for.'),
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const results = await search(ctx, {
        query: input.query,
        scopes: ['transcripts'],
        accountId: input.accountId,
        opportunityId: input.opportunityId,
        limit: input.limit,
      });
      return {
        summary: `${results.length} transcript${results.length === 1 ? '' : 's'} matched.`,
        data: results.map((r) => ({ id: r.ref.id, label: r.ref.label, excerpt: r.content.slice(0, 2000) })),
        sources: results.map((r) => r.ref),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_knowledge',
    description:
      'Search internal knowledge: product docs, pricing, security posture, playbooks, battlecards. Trusted workspace content.',
    input: z.object({ query: z.string().describe('What to look up.'), limit: limitField }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const results = await search(ctx, { query: input.query, scopes: ['knowledge'], limit: input.limit });
      return {
        summary: `${results.length} knowledge passage${results.length === 1 ? '' : 's'} matched.`,
        data: results.map((r) => ({ documentId: r.ref.id, label: r.ref.label, content: r.content })),
        sources: results.map((r) => r.ref),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_commitments',
    description: 'Find promises made by either side, with their due dates and source quotes.',
    input: z.object({
      accountId: z.string().optional(),
      opportunityId: z.string().optional(),
      direction: z.enum(['we_owe', 'they_owe']).optional(),
      status: z.enum(['open', 'fulfilled', 'overdue', 'unconfirmed']).optional(),
      dueWithinDays: z.number().int().min(0).max(365).optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const rows = await ctx.db
        .select({
          id: commitments.id,
          description: commitments.description,
          direction: commitments.direction,
          ownerLabel: commitments.ownerLabel,
          dueAt: commitments.dueAt,
          status: commitments.status,
          quote: commitments.sourceQuote,
          accountName: accounts.name,
          opportunityId: commitments.opportunityId,
        })
        .from(commitments)
        .leftJoin(accounts, eq(accounts.id, commitments.accountId))
        .where(
          scoped(
            ctx,
            commitments,
            input.accountId ? eq(commitments.accountId, input.accountId) : undefined,
            input.opportunityId ? eq(commitments.opportunityId, input.opportunityId) : undefined,
            input.direction ? eq(commitments.direction, input.direction) : undefined,
            input.status ? eq(commitments.status, input.status) : undefined,
            input.dueWithinDays != null
              ? lte(commitments.dueAt, new Date(Date.now() + input.dueWithinDays * 86_400_000))
              : undefined,
          ),
        )
        .orderBy(commitments.dueAt)
        .limit(input.limit);

      return {
        summary: `${rows.length} commitment${rows.length === 1 ? '' : 's'} found.`,
        data: rows.map((r) => ({
          id: r.id,
          description: r.description,
          direction: r.direction,
          owner: r.ownerLabel,
          account: r.accountName,
          opportunityId: r.opportunityId,
          dueAt: r.dueAt?.toISOString().slice(0, 10) ?? null,
          overdue: Boolean(r.dueAt && r.dueAt.getTime() < Date.now() && r.status === 'open'),
          status: r.status,
          quote: r.quote,
        })),
        sources: rows.map((r) => ({ type: 'commitment' as const, id: r.id, label: r.description.slice(0, 60) })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'analyze_deal',
    description:
      'Recompute and explain a deal\'s health score from current evidence. Returns the score with its positive and risk factors.',
    input: z.object({ opportunityId: z.string().describe('The opportunity id.') }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const health = await scoreOpportunityHealth(ctx, input.opportunityId);
      if (!health) return { summary: 'No such opportunity in this workspace.', data: null };

      return {
        summary: `Health ${health.score}/100 (${health.band}). ${health.positives.length} positive factors, ${health.risks.length} risks.`,
        data: {
          score: health.score,
          band: health.band,
          positives: health.positives.map((p) => ({ label: p.label, detail: p.detail, weight: p.weight })),
          risks: health.risks.map((r) => ({ label: r.label, detail: r.detail, weight: r.weight })),
          method: health.method,
        },
        sources: [...health.positives, ...health.risks].flatMap((b) => b.sources ?? []),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'get_fact_history',
    description:
      'How a known fact has changed over time, e.g. how a budget or timeline moved. Returns the full chain with dates and sources.',
    input: z.object({
      subjectType: z.enum(['account', 'contact', 'opportunity']),
      subjectId: z.string(),
      key: z.string().describe('Fact key, e.g. "budget", "timeline", "seat_count".'),
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const history = await factHistory(ctx, input.subjectType, input.subjectId, input.key);
      return {
        summary:
          history.length === 0
            ? `No recorded history for "${input.key}".`
            : `${history.length} recorded value${history.length === 1 ? '' : 's'} for "${input.key}".`,
        data: history.map((f) => ({
          value: displayValue(f),
          validFrom: f.validFrom.toISOString().slice(0, 10),
          validUntil: f.validUntil?.toISOString().slice(0, 10) ?? null,
          status: f.status,
          confidence: f.confidence,
          quote: f.sourceQuote,
        })),
        sources: history
          .filter((f) => f.sourceType && f.sourceId)
          .map((f) => ({
            type: f.sourceType as SourceRef['type'],
            id: f.sourceId!,
            label: `${f.label}: ${displayValue(f)}`,
            occurredAt: f.validFrom.toISOString(),
          })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'search_product_signals',
    description: 'Find feature requests, integration asks and security requirements extracted from conversations.',
    input: z.object({
      query: z.string().optional(),
      category: z
        .enum(['feature_request', 'bug', 'integration_request', 'security_requirement', 'pricing_concern', 'competitor', 'workflow_pain'])
        .optional(),
      accountId: z.string().optional(),
      limit: limitField,
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const rows = await ctx.db
        .select({
          id: productSignals.id,
          title: productSignals.title,
          detail: productSignals.detail,
          category: productSignals.category,
          urgency: productSignals.urgency,
          accountName: accounts.name,
          quote: productSignals.sourceQuote,
          occurredAt: productSignals.occurredAt,
        })
        .from(productSignals)
        .leftJoin(accounts, eq(accounts.id, productSignals.accountId))
        .where(
          scoped(
            ctx,
            productSignals,
            input.query ? ilike(productSignals.title, `%${input.query}%`) : undefined,
            input.category ? eq(productSignals.category, input.category) : undefined,
            input.accountId ? eq(productSignals.accountId, input.accountId) : undefined,
          ),
        )
        .orderBy(desc(productSignals.occurredAt))
        .limit(input.limit);

      return {
        summary: `${rows.length} product signal${rows.length === 1 ? '' : 's'} found.`,
        data: rows.map((r) => ({
          id: r.id,
          title: r.title,
          detail: r.detail,
          category: r.category,
          urgency: r.urgency,
          account: r.accountName,
          quote: r.quote,
          when: r.occurredAt.toISOString().slice(0, 10),
        })),
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'generate_report',
    description:
      'Run a pre-approved analytics report. Read-only aggregates over workspace data — never arbitrary SQL.',
    input: z.object({
      reportId: z
        .enum([
          'pipeline_created_by_month',
          'pipeline_by_stage',
          'win_rate_by_industry',
          'objections_vs_outcome',
          'product_demand_by_arr',
          'rep_conversion',
          'stalled_deals',
          'security_cycle_impact',
          'churn_risk',
        ])
        .describe('Which report to run.'),
      days: z.number().int().min(0).max(365).optional(),
      months: z.number().int().min(1).max(36).optional(),
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const { runReportById } = await import('@/server/analytics/ask');
      const result = await runReportById(ctx, input.reportId, { days: input.days, months: input.months });
      if (!result) return { summary: 'Unknown report.', data: null };
      return {
        summary: result.answer,
        data: { table: result.table, chart: result.chart, methodology: result.methodology },
        sources: result.sources,
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'prospect_accounts',
    description:
      'Derive the ideal customer profile from closed-won deals and return scored lookalike companies that are not yet in the CRM. Read-only — it does not create records or send anything.',
    input: z.object({
      query: z.string().max(200).optional().describe('Optional free-text narrowing, e.g. an industry or region.'),
      limit: z.number().int().min(1).max(25).default(8).describe('Maximum candidates (1-25).'),
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const { deriveIcp, findLookalikes } = await import('@/server/intelligence/prospecting');

      const icp = await deriveIcp(ctx);
      if (!icp) {
        return {
          summary:
            'Not enough closed-won history to derive an ICP. At least three won deals are needed before lookalike search means anything.',
          data: { icp: null, candidates: [] },
        };
      }

      const candidates = await findLookalikes(ctx, icp, {
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
      });

      return {
        summary: `Derived an ICP from ${icp.sampleSize} won deals and found ${candidates.length} lookalike ${
          candidates.length === 1 ? 'company' : 'companies'
        }.`,
        data: {
          icp: {
            narrative: icp.narrative,
            industries: icp.industries,
            employeeRange: icp.employeeRange,
            averageDealValue: icp.averageDealValue,
            averageCycleDays: icp.averageCycleDays,
            themes: icp.commonThemes,
            sampleSize: icp.sampleSize,
          },
          candidates: candidates.map((c) => ({
            name: c.name,
            domain: c.domain,
            industry: c.industry,
            employeeCount: c.employeeCount,
            location: c.location,
            score: c.score,
            factors: c.factors,
            whyThisAccount: c.whyThisAccount,
            angle: c.angle,
            contacts: c.contacts.map((p) => ({
              name: `${p.firstName} ${p.lastName}`,
              title: p.title,
              email: p.email,
            })),
            emailDraft: c.emailDraft,
          })),
        },
        sources: icp.evidence,
      };
    },
  }),
);

registerTool(
  defineTool({
    name: 'get_usage_health',
    description:
      'Product-usage and support health for an account: active-user trend, engagement direction, power users, and open ticket pressure. Use this to judge expansion readiness or churn risk.',
    input: z.object({
      accountId: z.string().describe('Account id.'),
    }),
    permission: 'record:read',
    risk: 'low',
    readOnly: true,
    async execute({ ctx }, input): Promise<ToolResult> {
      const { usageTrends, powerUsers, supportHealth } = await import('@/server/memory/external');

      // These are workspace-wide aggregates; filtering here keeps one query
      // plan rather than adding per-account variants of three SQL statements.
      const [trends, power, support] = await Promise.all([
        usageTrends(ctx, 0),
        powerUsers(ctx, 50),
        supportHealth(ctx),
      ]);

      const trend = trends.find((t) => t.accountId === input.accountId) ?? null;
      const champions = power.filter((p) => p.accountId === input.accountId).slice(0, 5);
      const tickets = support.find((r) => r.account_id === input.accountId) ?? null;

      if (!trend && champions.length === 0 && !tickets) {
        return {
          summary: 'No product-usage or support data has been ingested for this account.',
          data: { trend: null, powerUsers: [], support: null },
        };
      }

      const parts: string[] = [];
      if (trend) {
        parts.push(
          `Usage is ${trend.trend} — ${Math.round(trend.recentActiveUsers)} active users vs ${Math.round(
            trend.priorActiveUsers,
          )} in the prior 30 days (${trend.changePercent > 0 ? '+' : ''}${trend.changePercent}%).`,
        );
      }
      if (champions.length > 0) {
        parts.push(
          `${champions.length} power ${champions.length === 1 ? 'user' : 'users'}: ${champions
            .map((c) => c.name)
            .join(', ')}.`,
        );
      }
      if (tickets) {
        parts.push(
          `${tickets.open_tickets} open ${tickets.open_tickets === 1 ? 'ticket' : 'tickets'}, ${tickets.urgent_tickets} urgent, ${tickets.tickets_90d} in the last 90 days.`,
        );
      }

      return {
        summary: parts.join(' '),
        data: {
          trend,
          powerUsers: champions,
          support: tickets
            ? {
                openTickets: tickets.open_tickets,
                urgentTickets: tickets.urgent_tickets,
                tickets90d: tickets.tickets_90d,
                averageSentiment: Number(tickets.avg_sentiment.toFixed(2)),
                averageSatisfaction: tickets.avg_satisfaction,
              }
            : null,
        },
      };
    },
  }),
);
