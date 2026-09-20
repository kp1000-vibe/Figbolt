import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { memoryFacts } from '@/db/schema';
import type { FactStatus } from '@/db/schema';
import { scope, scoped, type Ctx } from '../context';
import { record } from '../audit';

/**
 * Temporal fact store.
 *
 * The rule: facts are never updated in place. Recording a new observation
 * closes the previous one's validity window and links the two, so the store can
 * answer both of the product's questions —
 *
 *   "What is Acme's budget?"          → the row with status='active'
 *   "How has Acme's budget changed?"  → walk the supersedes chain
 *
 * A CRM that overwrites `budget = 50000` with `budget = 100000` has destroyed
 * the more interesting fact, which is that it doubled in March.
 */

export type SubjectType = 'account' | 'contact' | 'opportunity';

export type FactInput = {
  subjectType: SubjectType;
  subjectId: string;
  accountId?: string | null;
  key: string;
  label: string;
  valueText?: string | null;
  valueNumber?: number | null;
  valueJson?: unknown;
  unit?: string | null;
  confidence?: number;
  source?: 'derived' | 'manual' | 'import' | 'integration';
  sourceType?: string | null;
  sourceId?: string | null;
  sourceQuote?: string | null;
  /** When the fact became true in the world, not when it was observed. */
  validFrom?: Date;
};

export type RecordFactResult = {
  fact: typeof memoryFacts.$inferSelect;
  outcome: 'created' | 'superseded_previous' | 'unchanged' | 'ignored_stale';
};

/**
 * Record an observation.
 *
 * Four outcomes, all deliberate:
 *  - `unchanged`      the same value is already active; only bump confidence
 *  - `ignored_stale`  the observation predates the active fact — don't rewrite
 *                     history backwards from a late-arriving old email
 *  - `superseded_previous` a genuine change: close the old row, insert a new one
 *  - `created`        first time we've learned this key for this subject
 */
export async function recordFact(ctx: Ctx, input: FactInput): Promise<RecordFactResult> {
  const validFrom = input.validFrom ?? new Date();
  const confidence = clamp(input.confidence ?? 0.6);

  const [active] = await ctx.db
    .select()
    .from(memoryFacts)
    .where(
      scoped(
        ctx,
        memoryFacts,
        eq(memoryFacts.subjectType, input.subjectType),
        eq(memoryFacts.subjectId, input.subjectId),
        eq(memoryFacts.key, input.key),
        eq(memoryFacts.status, 'active'),
      ),
    )
    .orderBy(desc(memoryFacts.validFrom))
    .limit(1);

  if (active) {
    if (sameValue(active, input)) {
      // Corroboration from an independent source raises confidence, but never
      // above the ceiling a derived fact is allowed to claim on its own.
      const boosted = clamp(Math.max(active.confidence, confidence) + 0.05);
      if (boosted !== active.confidence) {
        await ctx.db
          .update(memoryFacts)
          .set({ confidence: boosted })
          .where(eq(memoryFacts.id, active.id));
      }
      return { fact: { ...active, confidence: boosted }, outcome: 'unchanged' };
    }

    if (validFrom < active.validFrom) {
      // A backfilled older source disagreeing with a newer fact is history, not
      // an update. Store it as already-superseded so the chain stays complete.
      const [historical] = await ctx.db
        .insert(memoryFacts)
        .values({
          ...toRow(ctx, input, validFrom, confidence),
          status: 'superseded',
          validUntil: active.validFrom,
        })
        .returning();
      return { fact: historical!, outcome: 'ignored_stale' };
    }

    // A real change. Close the old window first so no two rows are ever active.
    await ctx.db
      .update(memoryFacts)
      .set({ status: 'superseded', validUntil: validFrom })
      .where(eq(memoryFacts.id, active.id));

    const [next] = await ctx.db
      .insert(memoryFacts)
      .values({
        ...toRow(ctx, input, validFrom, confidence),
        supersedesId: active.id,
      })
      .returning();

    await record(ctx, {
      action: 'memory.fact_changed',
      resourceType: input.subjectType,
      resourceId: input.subjectId,
      riskLevel: 'low',
      metadata: {
        key: input.key,
        from: displayValue(active),
        to: displayValue(next!),
        confidence,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      },
    });

    return { fact: next!, outcome: 'superseded_previous' };
  }

  const [created] = await ctx.db
    .insert(memoryFacts)
    .values(toRow(ctx, input, validFrom, confidence))
    .returning();

  return { fact: created!, outcome: 'created' };
}

function toRow(ctx: Ctx, input: FactInput, validFrom: Date, confidence: number) {
  return {
    workspaceId: ctx.workspaceId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    accountId: input.accountId ?? null,
    key: input.key,
    label: input.label,
    valueText: input.valueText ?? null,
    valueNumber: input.valueNumber ?? null,
    valueJson: input.valueJson ?? null,
    unit: input.unit ?? null,
    confidence,
    source: input.source ?? 'derived',
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    sourceQuote: input.sourceQuote ?? null,
    extractedByRunId: ctx.runId ?? null,
    updatedById: ctx.userId,
    status: 'active' as FactStatus,
    validFrom,
    validUntil: null,
  };
}

function sameValue(existing: typeof memoryFacts.$inferSelect, input: FactInput): boolean {
  if (input.valueNumber != null || existing.valueNumber != null) {
    if (input.valueNumber == null || existing.valueNumber == null) return false;
    // Treat sub-1% drift as restatement, not a change ("about $120k" vs "$120,000").
    const denom = Math.max(Math.abs(existing.valueNumber), 1);
    return Math.abs(existing.valueNumber - input.valueNumber) / denom < 0.01;
  }
  if (input.valueText != null || existing.valueText != null) {
    return normalise(existing.valueText) === normalise(input.valueText);
  }
  return JSON.stringify(existing.valueJson ?? null) === JSON.stringify(input.valueJson ?? null);
}

function normalise(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function displayValue(fact: typeof memoryFacts.$inferSelect): string {
  if (fact.valueNumber != null) {
    const formatted =
      fact.unit === 'USD'
        ? `$${fact.valueNumber.toLocaleString('en-US')}`
        : `${fact.valueNumber.toLocaleString('en-US')}${fact.unit ? ` ${fact.unit}` : ''}`;
    return formatted;
  }
  if (fact.valueText) return fact.valueText;
  if (fact.valueJson != null) return JSON.stringify(fact.valueJson);
  return '—';
}

/** Currently-true facts for a subject. */
export async function currentFacts(
  ctx: Ctx,
  subjectType: SubjectType,
  subjectId: string,
): Promise<(typeof memoryFacts.$inferSelect)[]> {
  return ctx.db
    .select()
    .from(memoryFacts)
    .where(
      scoped(
        ctx,
        memoryFacts,
        eq(memoryFacts.subjectType, subjectType),
        eq(memoryFacts.subjectId, subjectId),
        eq(memoryFacts.status, 'active'),
      ),
    )
    .orderBy(asc(memoryFacts.key));
}

/**
 * Time travel: what did we believe was true on a given date?
 * Used by "how has this changed" views and by analytics that must not read
 * today's values back onto last quarter.
 */
export async function factsAsOf(
  ctx: Ctx,
  subjectType: SubjectType,
  subjectId: string,
  asOf: Date,
): Promise<(typeof memoryFacts.$inferSelect)[]> {
  return ctx.db
    .select()
    .from(memoryFacts)
    .where(
      scoped(
        ctx,
        memoryFacts,
        eq(memoryFacts.subjectType, subjectType),
        eq(memoryFacts.subjectId, subjectId),
        lte(memoryFacts.validFrom, asOf),
        or(isNull(memoryFacts.validUntil), sql`${memoryFacts.validUntil} > ${asOf}`),
      ),
    )
    .orderBy(asc(memoryFacts.key), desc(memoryFacts.validFrom));
}

/** The full history of one key, newest first. */
export async function factHistory(
  ctx: Ctx,
  subjectType: SubjectType,
  subjectId: string,
  key: string,
): Promise<(typeof memoryFacts.$inferSelect)[]> {
  return ctx.db
    .select()
    .from(memoryFacts)
    .where(
      scoped(
        ctx,
        memoryFacts,
        eq(memoryFacts.subjectType, subjectType),
        eq(memoryFacts.subjectId, subjectId),
        eq(memoryFacts.key, key),
      ),
    )
    .orderBy(desc(memoryFacts.validFrom));
}

/** Keys whose value has changed at least once — the "what moved" view. */
export async function changedFacts(
  ctx: Ctx,
  subjectType: SubjectType,
  subjectId: string,
): Promise<{ key: string; label: string; changes: number }[]> {
  const rows = await ctx.db
    .select({
      key: memoryFacts.key,
      label: memoryFacts.label,
      changes: sql<number>`count(*)::int`,
    })
    .from(memoryFacts)
    .where(
      scoped(
        ctx,
        memoryFacts,
        eq(memoryFacts.subjectType, subjectType),
        eq(memoryFacts.subjectId, subjectId),
      ),
    )
    .groupBy(memoryFacts.key, memoryFacts.label)
    .having(sql`count(*) > 1`);
  return rows;
}

/** Mark a fact as wrong. Retraction keeps the row and the audit trail. */
export async function retractFact(ctx: Ctx, factId: string, reason: string): Promise<void> {
  const [fact] = await ctx.db
    .select()
    .from(memoryFacts)
    .where(and(scope(ctx, memoryFacts), eq(memoryFacts.id, factId)))
    .limit(1);
  if (!fact) return;

  await ctx.db
    .update(memoryFacts)
    .set({ status: 'retracted', validUntil: new Date(), updatedById: ctx.userId })
    .where(eq(memoryFacts.id, factId));

  await record(ctx, {
    action: 'memory.fact_retracted',
    resourceType: fact.subjectType,
    resourceId: fact.subjectId,
    riskLevel: 'low',
    metadata: { key: fact.key, value: displayValue(fact), reason },
  });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
