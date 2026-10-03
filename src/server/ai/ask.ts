import { and, desc, eq, sql } from 'drizzle-orm';
import { conversations, messages, workspaces, type SourceRef } from '@/db/schema';
import { getLanguageModel, getModelForTask } from '@/lib/ai';
import { s } from '@/lib/ai/providers/structured';
import { fitEvidence } from '@/lib/ai/prompt';
import type { AnswerEnvelope, EvidenceItem, RoutingSummary } from '@/lib/ai/types';
import { scope, scoped, type Ctx } from '../context';
import { ctxAssert } from '../context';
import { record } from '../audit';
import { search, resolveEntities, type SearchScope } from '../retrieval/search';
import { runAnalyticsQuestion } from '../analytics/ask';

/**
 * "Ask anything about your customers."
 *
 * The pipeline, per the retrieval architecture:
 *   classify intent → resolve entities → structured + semantic retrieval →
 *   rank → build context → reason → return with citations.
 *
 * Two hard rules are enforced here rather than requested in a prompt:
 *   - the answer's citations are filtered against the evidence that was
 *     actually retrieved, so a model cannot cite a record it never saw;
 *   - if retrieval came back empty, the answer says so and no model call is
 *     made to dress it up.
 */

const ASK_SYSTEM = `
You are Bolt, the AI analyst inside Figbolt, with access to this workspace's CRM.

How to answer:
- Ground every factual claim in the evidence provided. Cite with [E1], [E2] etc.
- Lead with the answer. Then the supporting detail. Be brief and concrete.
- Name real people, amounts and dates from the evidence. Never invent them.
- If the evidence only partly answers the question, say what is missing.
- If the evidence does not answer it at all, say so plainly. Do not speculate.
- Recommend next actions only when the evidence supports them.
`.trim();

const answerSchema = s.object(
  {
    answer: s.string('The answer in markdown. Cite evidence as [E1], [E2].'),
    confidence: s.number('0-1: how well the evidence supports this.'),
    citations: s.array({ type: 'integer' }, 'Evidence numbers actually used, e.g. [1,3].'),
    recommendedActions: s.array(
      s.nested(
        {
          title: s.string('Short imperative action.'),
          why: s.string('One sentence on why, referencing evidence.'),
        },
        'A recommended next action.',
        ['title', 'why'],
      ),
      'Up to 4 actions. Empty if none are warranted.',
    ),
    reasoningSummary: s.string('One sentence on how you reached this. No private reasoning.'),
    caveat: s.string('What is uncertain or missing. Empty if nothing.'),
  },
  ['answer', 'confidence', 'citations', 'recommendedActions', 'reasoningSummary'],
);

export type AskOptions = {
  question: string;
  conversationId?: string;
  /** Anchor the question to a record ("Ask about this account"). */
  scopeType?: 'account' | 'opportunity' | 'contact';
  scopeId?: string;
  persist?: boolean;
};

export type AskResult = AnswerEnvelope & {
  conversationId: string | null;
  messageId: string | null;
  evidence: EvidenceItem[];
  latencyMs: number;
  model: string;
  /** How `model` was chosen: by Jev, or by code when Jev did not decide. */
  routing?: RoutingSummary;
  /** Set when the question was routed to the analytics engine instead. */
  analytics?: Awaited<ReturnType<typeof runAnalyticsQuestion>>;
};

export async function ask(ctx: Ctx, options: AskOptions): Promise<AskResult> {
  ctxAssert(ctx, 'ai:ask');
  const started = Date.now();
  const question = options.question.trim();

  if (question.length < 2) {
    throw new Error('Ask a question with at least a couple of characters.');
  }

  const model = getLanguageModel();

  /* 1 — classify intent */
  const intent = await classifyIntent(ctx, question);

  /* 2 — analytics questions take a different, read-only path
   *
   * Attempted for any question that is not asking us to write something, not
   * only when the classifier said "analytics": the report catalogue matches on
   * specific patterns and returns null when none fit, so a template match is a
   * stronger signal than the classifier's label. "Which customers are at risk
   * of churning?" reads as a search question and is answered far better by the
   * retention report than by quoting two transcripts. */
  if (intent.intent !== 'draft' && intent.intent !== 'mutate') {
    const analytics = await runAnalyticsQuestion(ctx, question);
    if (analytics) {
      const envelope: AnswerEnvelope = {
        answer: analytics.answer,
        confidence: analytics.confidence,
        sources: analytics.sources,
        recommendedActions: [],
        extractedEntities: [],
        reasoningSummary: analytics.methodology,
      };
      // A report answered this; no language model ran.
      const persisted = await persist(ctx, options, question, envelope, 'report', Date.now() - started);
      return {
        ...envelope,
        ...persisted,
        evidence: [],
        latencyMs: Date.now() - started,
        model: 'report',
        analytics,
      };
    }
  }

  /* 3 — retrieve */
  const entities = await resolveEntities(ctx, question);
  const evidence = await search(ctx, {
    query: question,
    scopes: intent.scopes,
    accountId: options.scopeType === 'account' ? options.scopeId : undefined,
    opportunityId: options.scopeType === 'opportunity' ? options.scopeId : undefined,
    sinceDays: intent.timeframeDays,
    limit: 16,
  });

  if (evidence.length === 0) {
    const envelope: AnswerEnvelope = {
      answer:
        "I couldn't find anything in this workspace that relates to that. No emails, meetings, notes or CRM records matched — so rather than guess, I'd rather tell you there's nothing here.",
      confidence: 0.1,
      sources: [],
      recommendedActions: [],
      extractedEntities: [],
      reasoningSummary: 'Searched CRM records, conversations and knowledge; no matches.',
      caveat: 'No matching records found.',
    };
    const persisted = await persist(ctx, options, question, envelope, 'none', Date.now() - started);
    return { ...envelope, ...persisted, evidence: [], latencyMs: Date.now() - started, model: 'none' };
  }

  /* 4 — build context within a token budget */
  const fitted = fitEvidence(evidence, 24_000);
  const workspaceContext = await loadWorkspaceContext(ctx);

  /* 5 — reason */
  const result = await model.completeStructured<Record<string, unknown>>({
    system: ASK_SYSTEM,
    instruction: question,
    schema: answerSchema,
    task: 'answer_question',
    evidence: fitted,
    workspaceContext,
    temperature: 0.2,
  });

  const v = result.value;

  // Citations are validated against what was actually retrieved. A number the
  // model invented, or one pointing past the end of the evidence list, is
  // dropped rather than rendered as a broken link.
  const citedIndexes = Array.isArray(v['citations'])
    ? (v['citations'] as unknown[])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= fitted.length)
    : [];

  const sources: SourceRef[] =
    citedIndexes.length > 0
      ? [...new Set(citedIndexes)].map((i) => fitted[i - 1]!.ref)
      : // The model answered without explicit citations; attribute the top
        // evidence rather than presenting an unsourced claim.
        fitted.slice(0, 3).map((e) => e.ref);

  const envelope: AnswerEnvelope = {
    answer: String(v['answer'] ?? '').trim(),
    confidence: clamp(Number(v['confidence'] ?? result.confidence)),
    sources,
    recommendedActions: Array.isArray(v['recommendedActions'])
      ? (v['recommendedActions'] as { title?: string; why?: string }[])
          .filter((a) => a.title)
          .slice(0, 4)
          .map((a) => ({ title: String(a.title), why: String(a.why ?? '') }))
      : [],
    extractedEntities: [
      ...entities.accounts.map((a) => ({ type: 'account', id: a.id, label: a.name })),
      ...entities.opportunities.map((o) => ({ type: 'opportunity', id: o.id, label: o.name })),
      ...entities.contacts.map((c) => ({ type: 'contact', id: c.id, label: c.name })),
    ],
    reasoningSummary: String(v['reasoningSummary'] ?? ''),
    caveat: (v['caveat'] as string)?.trim() || undefined,
  };

  const latencyMs = Date.now() - started;
  // result.model is the model that actually answered — with Jev routing,
  // model.id would only name the router.
  const persisted = await persist(ctx, options, question, envelope, result.model, latencyMs, result.usage);

  await record(ctx, {
    action: 'ai.question_answered',
    resourceType: 'conversation',
    resourceId: persisted.conversationId ?? undefined,
    riskLevel: 'low',
    metadata: {
      question: question.slice(0, 200),
      evidenceCount: fitted.length,
      confidence: envelope.confidence,
      intent: intent.intent,
      latencyMs,
      model: result.model,
      modelChosenBy: result.routing?.decidedBy ?? 'default',
      routingReason: result.routing?.reason,
      failedOverFrom: result.routing?.failedOverFrom,
    },
  });

  return {
    ...envelope,
    ...persisted,
    evidence: fitted,
    latencyMs,
    model: result.model,
    routing: result.routing,
  };
}

/* ── Intent ───────────────────────────────────────────────────────────────── */

export type Intent = {
  intent: 'search' | 'explain' | 'analytics' | 'draft' | 'mutate';
  scopes: SearchScope[];
  timeframeDays: number;
};

async function classifyIntent(ctx: Ctx, question: string): Promise<Intent> {
  // Routed: a five-way label from one sentence is the cheapest job in the
  // product and runs on every question asked. Paying top-tier prices for it
  // is how an AI budget disappears with nothing to show.
  const { model } = await getModelForTask({
    task: 'classify_intent',
    instruction: question,
    expectsProse: false,
  });
  try {
    const result = await model.completeStructured<Record<string, unknown>>({
      system:
        'You route CRM questions. Pick the intent and which record types to search. Be inclusive with scopes — a missed scope means a missed answer.',
      instruction: question,
      schema: s.object(
        {
          intent: s.enum(['search', 'explain', 'analytics', 'draft', 'mutate'], 'What the user wants.'),
          scopes: s.strings('Record types to search.'),
          timeframeDays: s.integer('Days of history implied by the question, 0 for all time.'),
          confidence: s.number('0-1.'),
        },
        ['intent', 'scopes', 'timeframeDays', 'confidence'],
      ),
      task: 'classify_intent',
      temperature: 0,
      maxTokens: 500,
    });

    const v = result.value;
    const valid: SearchScope[] = [
      'accounts', 'contacts', 'opportunities', 'emails', 'meetings', 'transcripts',
      'notes', 'tasks', 'commitments', 'objections', 'product_signals', 'crm_events', 'knowledge',
    ];
    const scopes = (Array.isArray(v['scopes']) ? (v['scopes'] as unknown[]) : [])
      .map(String)
      .filter((x): x is SearchScope => (valid as string[]).includes(x));

    return {
      intent: (v['intent'] as Intent['intent']) ?? 'search',
      scopes: scopes.length > 0 ? scopes : ['accounts', 'opportunities', 'emails', 'meetings', 'transcripts'],
      timeframeDays: Math.max(0, Number(v['timeframeDays'] ?? 0)),
    };
  } catch {
    // Classification is an optimisation, not a gate — fall back to broad search.
    return {
      intent: 'search',
      scopes: ['accounts', 'opportunities', 'emails', 'meetings', 'transcripts', 'commitments', 'objections'],
      timeframeDays: 0,
    };
  }
}

/* ── Persistence ──────────────────────────────────────────────────────────── */

async function persist(
  ctx: Ctx,
  options: AskOptions,
  question: string,
  envelope: AnswerEnvelope,
  model: string,
  latencyMs: number,
  usage?: { promptTokens: number; completionTokens: number },
): Promise<{ conversationId: string | null; messageId: string | null }> {
  if (options.persist === false || !ctx.userId) return { conversationId: null, messageId: null };

  let conversationId = options.conversationId ?? null;

  if (conversationId) {
    const [existing] = await ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(scope(ctx, conversations), eq(conversations.id, conversationId), eq(conversations.userId, ctx.userId)))
      .limit(1);
    if (!existing) conversationId = null;
  }

  if (!conversationId) {
    const [created] = await ctx.db
      .insert(conversations)
      .values({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        title: question.slice(0, 80),
        scopeType: options.scopeType ?? null,
        scopeId: options.scopeId ?? null,
      })
      .returning({ id: conversations.id });
    conversationId = created!.id;
  } else {
    await ctx.db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  }

  await ctx.db.insert(messages).values({
    workspaceId: ctx.workspaceId,
    conversationId,
    role: 'user',
    content: question,
  });

  const [assistant] = await ctx.db
    .insert(messages)
    .values({
      workspaceId: ctx.workspaceId,
      conversationId,
      role: 'assistant',
      content: envelope.answer,
      envelope: envelope as unknown as Record<string, unknown>,
      latencyMs,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      model,
    })
    .returning({ id: messages.id });

  return { conversationId, messageId: assistant!.id };
}

async function loadWorkspaceContext(ctx: Ctx): Promise<string> {
  const [ws] = await ctx.db
    .select({ name: workspaces.name, companyContext: workspaces.companyContext })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) return '';

  const c = ws.companyContext;
  return [
    `Workspace: ${ws.name}`,
    c?.whatWeSell ? `What we sell: ${c.whatWeSell}` : null,
    c?.idealCustomer ? `Ideal customer: ${c.idealCustomer}` : null,
    c?.qualificationCriteria ? `Qualified means: ${c.qualificationCriteria}` : null,
    c?.competitors?.length ? `Competitors: ${c.competitors.join(', ')}` : null,
    c?.differentiators ? `Differentiators: ${c.differentiators}` : null,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function listConversations(ctx: Ctx, limit = 30) {
  if (!ctx.userId) return [];
  return ctx.db
    .select()
    .from(conversations)
    .where(scoped(ctx, conversations, eq(conversations.userId, ctx.userId)))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function getConversation(ctx: Ctx, conversationId: string) {
  const [conversation] = await ctx.db
    .select()
    .from(conversations)
    .where(and(scope(ctx, conversations), eq(conversations.id, conversationId)))
    .limit(1);
  if (!conversation) return null;
  if (ctx.userId && conversation.userId !== ctx.userId) return null;

  const rows = await ctx.db
    .select()
    .from(messages)
    .where(scoped(ctx, messages, eq(messages.conversationId, conversationId)))
    .orderBy(messages.createdAt);

  return { conversation, messages: rows };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, Number((value > 1 ? value / 100 : value).toFixed(2))));
}
