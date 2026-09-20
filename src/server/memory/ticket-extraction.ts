import { eq, inArray, sql } from 'drizzle-orm';
import { objections, productSignals, productSignalThemes, type SourceRef } from '@/db/schema';
import { getLanguageModel } from '@/lib/ai';
import { s } from '@/lib/ai/providers/structured';
import { overlap } from '@/lib/ai/local/nlp';
import { scoped, type Ctx } from '../context';
import { addTimelineEvent } from './timeline';

/**
 * Extraction for support tickets.
 *
 * Kept separate from `ingest.ts` because a ticket is not a sales conversation:
 * commitments and buying signals are the wrong lens, while bugs, integration
 * failures and churn language are the right one. Running the sales extractors
 * over a ticket would mostly produce noise.
 */

const TICKET_SYSTEM = `
You extract product and risk signals from customer support tickets.

Rules:
- Only report what the ticket actually says. Copy the supporting sentence verbatim into "quote".
- A ticket describing a defect is a bug. A ticket asking for something we do not have is a request.
- Language about leaving, cancelling or "reconsidering at renewal" is a churn risk, not a bug.
- An empty array is a correct answer.
`.trim();

export async function runTicketExtraction(
  ctx: Ctx,
  input: {
    source: SourceRef;
    text: string;
    accountId: string | null;
    contactId: string | null;
    occurredAt: Date;
  },
): Promise<void> {
  const model = getLanguageModel();

  const result = await model
    .completeStructured<{
      signals: {
        category: string;
        title: string;
        detail: string;
        urgency: 'low' | 'medium' | 'high' | 'blocking';
        quote: string;
        confidence: number;
      }[];
      churnRisk: { present: boolean; summary: string; quote: string; confidence: number };
    }>({
      system: TICKET_SYSTEM,
      instruction: 'Extract product signals and any churn risk from this support ticket.',
      schema: s.object(
        {
          signals: s.array(
            s.nested(
              {
                category: s.enum(
                  ['bug', 'feature_request', 'integration_request', 'workflow_pain', 'security_requirement', 'pricing_concern'],
                  'Signal category.',
                ),
                title: s.string('Short canonical name.'),
                detail: s.string('What the customer described.'),
                urgency: s.enum(['low', 'medium', 'high', 'blocking'], 'How badly it affects them.'),
                quote: s.string('Verbatim sentence.'),
                confidence: s.number('0-1.'),
              },
              'A product signal.',
              ['category', 'title', 'detail', 'urgency', 'quote', 'confidence'],
            ),
            'Signals found. Empty array if none.',
          ),
          churnRisk: s.nested(
            {
              present: s.boolean('True only if the customer hinted at leaving.'),
              summary: s.string('One line, or empty.'),
              quote: s.string('Verbatim sentence, or empty.'),
              confidence: s.number('0-1.'),
            },
            'Churn risk.',
            ['present', 'confidence'],
          ),
          confidence: s.number('Overall confidence 0-1.'),
        },
        ['signals', 'churnRisk', 'confidence'],
      ),
      task: 'extract_product_signals',
      evidence: [
        {
          ref: input.source,
          content: input.text,
          trust: 'untrusted',
          metadata: { isCustomer: true, speaker: 'Customer (support)' },
        },
      ],
    })
    .catch((err: Error) => {
      console.warn('[ticket-extraction] failed, continuing:', err.message);
      return {
        value: { signals: [], churnRisk: { present: false, summary: '', quote: '', confidence: 0 } },
        usage: { promptTokens: 0, completionTokens: 0 },
        model: 'none',
        confidence: 0,
      };
    });

  for (const signal of result.value.signals ?? []) {
    if (!signal.title || signal.confidence < 0.5) continue;

    const themeId = await ensureTheme(ctx, signal.title, signal.category);

    // Cross-source dedupe, same rule as the sales pipeline: one concern with
    // several pieces of evidence, not several concerns.
    const candidates = await ctx.db
      .select({ id: productSignals.id, title: productSignals.title })
      .from(productSignals)
      .where(
        scoped(
          ctx,
          productSignals,
          input.accountId ? eq(productSignals.accountId, input.accountId) : undefined,
          eq(productSignals.category, signal.category as never),
        ),
      )
      .limit(40);

    if (candidates.some((c) => overlap(c.title, signal.title) >= 0.7)) continue;

    await ctx.db.insert(productSignals).values({
      workspaceId: ctx.workspaceId,
      themeId,
      category: signal.category as never,
      title: signal.title,
      detail: signal.detail,
      accountId: input.accountId,
      contactId: input.contactId,
      urgency: signal.urgency,
      sourceType: 'note',
      sourceId: input.source.id,
      sourceQuote: signal.quote,
      confidence: signal.confidence,
      occurredAt: input.occurredAt,
    });

    if (input.accountId) {
      await addTimelineEvent(ctx, {
        type: signal.category === 'bug' ? 'risk_detected' : 'feature_requested',
        subjectType: 'account',
        subjectId: input.accountId,
        accountId: input.accountId,
        contactId: input.contactId,
        title: `${signal.category === 'bug' ? 'Bug reported' : 'Requested'}: ${signal.title}`,
        body: signal.quote,
        importance: signal.urgency === 'blocking' ? 5 : 3,
        occurredAt: input.occurredAt,
        sourceType: 'note',
        sourceId: input.source.id,
      });
    }
  }

  const churn = result.value.churnRisk;
  if (churn?.present && churn.confidence >= 0.55 && input.accountId) {
    // Churn language is recorded as a high-severity "need" objection, so it
    // flows into deal health and the Inbox rather than sitting in a support tool.
    const candidates = await ctx.db
      .select({ id: objections.id, summary: objections.summary })
      .from(objections)
      .where(
        scoped(
          ctx,
          objections,
          eq(objections.accountId, input.accountId),
          eq(objections.category, 'need'),
          inArray(objections.status, ['open', 'addressed']),
        ),
      )
      .limit(20);

    const duplicate = candidates.some((c) => overlap(c.summary, churn.summary) >= 0.55);

    if (!duplicate) {
      await ctx.db.insert(objections).values({
        workspaceId: ctx.workspaceId,
        category: 'need',
        summary: churn.summary || 'Customer hinted at not continuing',
        accountId: input.accountId,
        contactId: input.contactId,
        severity: 'high',
        status: 'open',
        sourceType: 'note',
        sourceId: input.source.id,
        sourceQuote: churn.quote,
        confidence: churn.confidence,
        occurredAt: input.occurredAt,
      });

      await addTimelineEvent(ctx, {
        type: 'risk_detected',
        subjectType: 'account',
        subjectId: input.accountId,
        accountId: input.accountId,
        contactId: input.contactId,
        title: `Churn risk: ${churn.summary}`,
        body: churn.quote,
        importance: 5,
        occurredAt: input.occurredAt,
        sourceType: 'note',
        sourceId: input.source.id,
      });
    }
  }
}

async function ensureTheme(ctx: Ctx, title: string, category: string): Promise<string | null> {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  if (!slug) return null;

  const [existing] = await ctx.db
    .select({ id: productSignalThemes.id })
    .from(productSignalThemes)
    .where(scoped(ctx, productSignalThemes, eq(productSignalThemes.slug, slug)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await ctx.db
    .insert(productSignalThemes)
    .values({ workspaceId: ctx.workspaceId, name: title, category: category as never, slug })
    .onConflictDoNothing()
    .returning({ id: productSignalThemes.id });

  if (created) return created.id;

  const [raced] = await ctx.db
    .select({ id: productSignalThemes.id })
    .from(productSignalThemes)
    .where(scoped(ctx, productSignalThemes, eq(productSignalThemes.slug, slug)))
    .limit(1);
  return raced?.id ?? null;
}
