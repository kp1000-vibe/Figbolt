import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  emails,
  embeddings,
  meetings,
  meetingParticipants,
  notes,
  objections,
  opportunities,
  productSignals,
  productSignalThemes,
  relationships,
  transcripts,
  type MeetingIntelligence,
  type SourceRef,
} from '@/db/schema';
import { getEmbeddingModel, getLanguageModel } from '@/lib/ai';
import { chunkText, toVectorLiteral } from '@/lib/ai/embeddings';
import { s } from '@/lib/ai/providers/structured';
import {
  detectCompetitors,
  scoreSentiment,
  type Utterance,
} from '@/lib/ai/local/extract';
import type { EvidenceItem } from '@/lib/ai/types';
import { overlap } from '@/lib/ai/local/nlp';
import { scope, scoped, type Ctx } from '../context';
import { record } from '../audit';
import { recordFact } from './facts';
import { addActivity, addTimelineEvent } from './timeline';

/**
 * The Customer Memory Engine.
 *
 * When an interaction arrives this pipeline runs, in order:
 *
 *   1. the raw source is stored verbatim and never mutated again
 *   2. it is resolved to contacts / accounts / opportunities
 *   3. it is chunked and embedded for semantic retrieval
 *   4. structured facts, commitments, objections, competitors, product signals
 *      and buying signals are extracted — each keeping its verbatim quote
 *   5. timeline events are written
 *   6. the rolling relationship summary and health score are refreshed
 *
 * Extraction goes through the `LanguageModel` interface, so the same pipeline
 * runs against a hosted model or the offline engine. Derived rows always carry
 * `sourceType`/`sourceId`/`sourceQuote`, which is what makes every claim in the
 * UI clickable back to the sentence that produced it.
 */

/* ── Entity resolution ────────────────────────────────────────────────────── */

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com',
]);

export type ResolvedParties = {
  contactIds: string[];
  accountId: string | null;
  opportunityId: string | null;
};

/**
 * Map raw email addresses onto CRM records.
 *
 * Domain matching is skipped for consumer mail providers — otherwise every
 * gmail.com address would collapse onto whichever account happened to have a
 * gmail contact first.
 */
export async function resolveParties(
  ctx: Ctx,
  addresses: string[],
  hint?: { accountId?: string | null; opportunityId?: string | null },
): Promise<ResolvedParties> {
  const normalised = [...new Set(addresses.map((a) => a.toLowerCase().trim()).filter(Boolean))];
  if (normalised.length === 0) {
    return { contactIds: [], accountId: hint?.accountId ?? null, opportunityId: hint?.opportunityId ?? null };
  }

  const matchedContacts = await ctx.db
    .select({ id: contacts.id, accountId: contacts.accountId, email: contacts.email })
    .from(contacts)
    .where(scoped(ctx, contacts, inArray(sql`lower(${contacts.email})`, normalised)));

  let accountId = hint?.accountId ?? matchedContacts.find((c) => c.accountId)?.accountId ?? null;

  if (!accountId) {
    const domains = [
      ...new Set(
        normalised
          .map((a) => a.split('@')[1])
          .filter((d): d is string => Boolean(d)),
      ),
    ].filter((d) => !FREE_EMAIL_DOMAINS.has(d));
    if (domains.length > 0) {
      const [byDomain] = await ctx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(scoped(ctx, accounts, inArray(sql`lower(${accounts.domain})`, domains)))
        .limit(1);
      accountId = byDomain?.id ?? null;
    }
  }

  let opportunityId = hint?.opportunityId ?? null;
  if (!opportunityId && accountId) {
    // Attach to the account's most recently touched open deal — the usual
    // intent when a thread relates to an account with one live opportunity.
    const [openOpp] = await ctx.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(scoped(ctx, opportunities, eq(opportunities.accountId, accountId), eq(opportunities.status, 'open')))
      .orderBy(desc(opportunities.lastInteractionAt), desc(opportunities.createdAt))
      .limit(1);
    opportunityId = openOpp?.id ?? null;
  }

  return { contactIds: matchedContacts.map((c) => c.id), accountId, opportunityId };
}

/* ── Embedding ────────────────────────────────────────────────────────────── */

export async function indexForSearch(
  ctx: Ctx,
  input: {
    ownerType: string;
    ownerId: string;
    label: string;
    text: string;
    accountId?: string | null;
    opportunityId?: string | null;
    contactId?: string | null;
    occurredAt?: Date | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const chunks = chunkText(input.text);
  if (chunks.length === 0) return;

  const embedder = getEmbeddingModel();
  const vectors = await embedder.embed(chunks.map((c) => c.content));

  // Re-indexing replaces prior chunks so a shorter revision cannot leave
  // orphaned text behind to be retrieved later.
  await ctx.db
    .delete(embeddings)
    .where(
      and(
        scope(ctx, embeddings),
        eq(embeddings.ownerType, input.ownerType),
        eq(embeddings.ownerId, input.ownerId),
      ),
    );

  for (const [i, chunk] of chunks.entries()) {
    const vector = vectors[i];
    await ctx.db.insert(embeddings).values({
      workspaceId: ctx.workspaceId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      chunkIndex: chunk.index,
      content: chunk.content,
      embedding: vector ? (sql`${toVectorLiteral(vector)}::vector` as never) : null,
      accountId: input.accountId ?? null,
      opportunityId: input.opportunityId ?? null,
      contactId: input.contactId ?? null,
      occurredAt: input.occurredAt ?? null,
      metadata: { label: input.label, ...input.metadata },
      model: embedder.id,
    });
  }
}

/* ── Extraction schemas ───────────────────────────────────────────────────── */

const commitmentSchema = s.object(
  {
    commitments: s.array(
      s.nested(
        {
          description: s.string('The promise, phrased as an action.'),
          direction: s.enum(['we_owe', 'they_owe'], 'Who owes the action.'),
          ownerLabel: s.string('Name of the person who owes it.'),
          dueHint: s.string('Due date as stated, e.g. "by Friday". Empty if none.'),
          quote: s.string('Verbatim sentence this came from.'),
          segmentIndex: s.integer('Transcript segment index, or -1.'),
          confidence: s.number('0-1 confidence.'),
        },
        'A commitment.',
        ['description', 'direction', 'ownerLabel', 'quote', 'confidence'],
      ),
      'Commitments found. Empty array if none.',
    ),
    confidence: s.number('Overall confidence 0-1.'),
  },
  ['commitments', 'confidence'],
);

const objectionSchema = s.object(
  {
    objections: s.array(
      s.nested(
        {
          category: s.enum(
            ['price', 'security', 'compliance', 'timing', 'competitor', 'integration', 'complexity', 'authority', 'need', 'support', 'other'],
            'Objection category.',
          ),
          summary: s.string('One-line summary.'),
          severity: s.enum(['low', 'medium', 'high'], 'How much this threatens the deal.'),
          quote: s.string('Verbatim sentence.'),
          confidence: s.number('0-1 confidence.'),
        },
        'An objection.',
        ['category', 'summary', 'severity', 'quote', 'confidence'],
      ),
      'Objections found. Empty array if none.',
    ),
    confidence: s.number('Overall confidence 0-1.'),
  },
  ['objections', 'confidence'],
);

const signalSchema = s.object(
  {
    signals: s.array(
      s.nested(
        {
          category: s.enum(
            ['feature_request', 'bug', 'integration_request', 'security_requirement', 'pricing_concern', 'competitor', 'workflow_pain'],
            'Signal category.',
          ),
          title: s.string('Short canonical name, e.g. "SSO / SAML".'),
          detail: s.string('What was asked for.'),
          urgency: s.enum(['low', 'medium', 'high', 'blocking'], 'How badly they need it.'),
          quote: s.string('Verbatim sentence.'),
          confidence: s.number('0-1 confidence.'),
        },
        'A product signal.',
        ['category', 'title', 'detail', 'urgency', 'quote', 'confidence'],
      ),
      'Product signals found. Empty array if none.',
    ),
    confidence: s.number('Overall confidence 0-1.'),
  },
  ['signals', 'confidence'],
);

const factSchema = s.object(
  {
    facts: s.array(
      s.nested(
        {
          key: s.enum(
            ['budget', 'seat_count', 'timeline', 'decision_process', 'use_case', 'current_solution', 'renewal_date'],
            'Stable machine key.',
          ),
          label: s.string('Human label.'),
          valueText: s.string('Text value, or empty.'),
          valueNumber: s.number('Numeric value, or 0.'),
          unit: s.string('Unit such as USD or seats, or empty.'),
          quote: s.string('Verbatim sentence.'),
          confidence: s.number('0-1 confidence.'),
        },
        'A structured fact.',
        ['key', 'label', 'quote', 'confidence'],
      ),
      'Facts found. Empty array if none.',
    ),
    confidence: s.number('Overall confidence 0-1.'),
  },
  ['facts', 'confidence'],
);

const EXTRACTION_SYSTEM = `
You extract structured CRM knowledge from customer conversations.

Rules:
- Only report what the text actually says. Never infer a value that is not stated.
- Copy the supporting sentence verbatim into "quote". If you cannot quote it, do not report it.
- Prefer returning fewer, well-supported items over many speculative ones.
- An empty array is a correct and useful answer.
`.trim();

type ExtractedCommitmentRow = {
  description: string;
  direction: 'we_owe' | 'they_owe';
  ownerLabel: string;
  dueHint?: string;
  quote: string;
  segmentIndex?: number;
  confidence: number;
};

/* ── Email ingestion ──────────────────────────────────────────────────────── */

export type IngestEmailInput = {
  emailId: string;
  /** Skip extraction — used during bulk seeding of low-signal messages. */
  extract?: boolean;
};

export async function ingestEmail(ctx: Ctx, input: IngestEmailInput): Promise<void> {
  const [email] = await ctx.db
    .select()
    .from(emails)
    .where(and(scope(ctx, emails), eq(emails.id, input.emailId)))
    .limit(1);
  if (!email) return;

  const parties = await resolveParties(
    ctx,
    [email.fromEmail, ...email.toEmails, ...email.ccEmails],
    { accountId: email.accountId, opportunityId: email.opportunityId },
  );

  const sentiment = scoreSentiment(email.bodyText);

  await ctx.db
    .update(emails)
    .set({
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      contactId: email.contactId ?? parties.contactIds[0] ?? null,
      sentiment,
      processedAt: new Date(),
    })
    .where(eq(emails.id, email.id));

  await indexForSearch(ctx, {
    ownerType: 'email',
    ownerId: email.id,
    label: `Email — ${email.subject}`,
    text: `Subject: ${email.subject}\n\n${email.bodyText}`,
    accountId: parties.accountId,
    opportunityId: parties.opportunityId,
    contactId: parties.contactIds[0] ?? null,
    occurredAt: email.sentAt,
    metadata: { direction: email.direction, from: email.fromName ?? email.fromEmail },
  });

  await addActivity(ctx, {
    type: 'email',
    subjectType: 'account',
    subjectId: parties.accountId ?? email.id,
    accountId: parties.accountId,
    contactId: parties.contactIds[0] ?? null,
    opportunityId: parties.opportunityId,
    title: email.subject,
    summary: email.bodySnippet ?? email.bodyText.slice(0, 200),
    direction: email.direction,
    occurredAt: email.sentAt,
    sourceType: 'email',
    sourceId: email.id,
  });

  if (parties.accountId) {
    await addTimelineEvent(ctx, {
      type: email.direction === 'inbound' ? 'email_received' : 'email_sent',
      subjectType: 'account',
      subjectId: parties.accountId,
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      contactId: parties.contactIds[0] ?? null,
      title: email.subject,
      body: email.bodySnippet ?? null,
      occurredAt: email.sentAt,
      sourceType: 'email',
      sourceId: email.id,
    });
  }

  if (input.extract !== false && email.bodyText.length > 80) {
    const utterance: Utterance = {
      text: email.bodyText,
      speaker: email.fromName ?? email.fromEmail,
      isCustomer: email.direction === 'inbound',
      index: 0,
    };
    const source: SourceRef = {
      type: 'email',
      id: email.id,
      label: `Email — ${email.subject}`,
      occurredAt: email.sentAt.toISOString(),
    };
    await runExtraction(ctx, {
      evidence: [{ ref: source, content: email.bodyText, trust: 'untrusted', metadata: { speaker: utterance.speaker, isCustomer: utterance.isCustomer } }],
      sourceType: 'email',
      sourceId: email.id,
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      contactId: parties.contactIds[0] ?? null,
      occurredAt: email.sentAt,
    });
  }

  await touchLastInteraction(ctx, parties, email.sentAt);
}

/* ── Meeting ingestion ────────────────────────────────────────────────────── */

export async function ingestMeeting(ctx: Ctx, meetingId: string): Promise<MeetingIntelligence | null> {
  const [meeting] = await ctx.db
    .select()
    .from(meetings)
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)))
    .limit(1);
  if (!meeting) return null;

  const [transcript] = await ctx.db
    .select()
    .from(transcripts)
    .where(and(scope(ctx, transcripts), eq(transcripts.meetingId, meetingId)))
    .limit(1);

  const participants = await ctx.db
    .select()
    .from(meetingParticipants)
    .where(and(scope(ctx, meetingParticipants), eq(meetingParticipants.meetingId, meetingId)));

  const parties = await resolveParties(ctx, meeting.participantEmails, {
    accountId: meeting.accountId,
    opportunityId: meeting.opportunityId,
  });

  // Each transcript segment becomes its own evidence item so extracted rows can
  // cite an exact line rather than "somewhere in this meeting".
  const evidence: EvidenceItem[] = transcript
    ? transcript.segments.map((seg) => ({
        ref: {
          type: 'transcript' as const,
          id: transcript.id,
          label: `${meeting.title} — ${seg.speaker}`,
          occurredAt: meeting.startsAt.toISOString(),
          snippet: seg.text.slice(0, 160),
        },
        content: seg.text,
        trust: 'untrusted' as const,
        metadata: { speaker: seg.speaker, isCustomer: seg.isCustomer, segmentIndex: seg.index },
      }))
    : [
        {
          ref: {
            type: 'meeting' as const,
            id: meeting.id,
            label: meeting.title,
            occurredAt: meeting.startsAt.toISOString(),
          },
          content: meeting.description ?? meeting.title,
          trust: 'untrusted' as const,
        },
      ];

  const knownCompetitors = await workspaceCompetitors(ctx);
  const model = getLanguageModel();

  const summarySchema = s.object(
    {
      summary: s.string('2-4 sentence summary of what happened.'),
      keyDecisions: s.strings('Decisions explicitly agreed.'),
      customerPains: s.strings('Problems the customer described.'),
      questions: s.strings('Questions the customer asked.'),
      objections: s.strings('Concerns raised, prefixed with the category.'),
      competitorsMentioned: s.strings('Competitor names mentioned.'),
      pricingDiscussion: s.string('What was said about price, or empty.'),
      productRequests: s.strings('Features or integrations requested.'),
      nextSteps: s.strings('Agreed next steps.'),
      sentimentLabel: s.enum(['positive', 'neutral', 'mixed', 'negative'], 'Overall tone.'),
      sentimentReason: s.string('Why that tone.'),
      confidence: s.number('0-1 confidence.'),
    },
    ['summary', 'keyDecisions', 'customerPains', 'questions', 'objections', 'nextSteps', 'sentimentLabel', 'sentimentReason', 'confidence'],
  );

  const instruction = [
    `meetingTitle: ${meeting.title}`,
    `knownCompetitors: ${knownCompetitors.join(', ')}`,
    '',
    'Summarise this meeting for a sales team. Ground every item in what was said.',
  ].join('\n');

  const result = await model.completeStructured<Record<string, unknown>>({
    system: EXTRACTION_SYSTEM,
    instruction,
    schema: summarySchema,
    task: 'summarize_meeting',
    evidence,
    workspaceContext: `Known competitors: ${knownCompetitors.join(', ')}`,
  });

  const v = result.value;
  const sources: SourceRef[] = evidence.slice(0, 8).map((e) => e.ref);

  const intelligence: MeetingIntelligence = {
    summary: String(v['summary'] ?? ''),
    keyDecisions: asStrings(v['keyDecisions']),
    customerPains: asStrings(v['customerPains']),
    questions: asStrings(v['questions']),
    objections: asStrings(v['objections']),
    competitorsMentioned: asStrings(v['competitorsMentioned']).length
      ? asStrings(v['competitorsMentioned'])
      : detectCompetitors(transcript?.fullText ?? '', knownCompetitors),
    pricingDiscussion: (v['pricingDiscussion'] as string) || null,
    productRequests: asStrings(v['productRequests']),
    nextSteps: asStrings(v['nextSteps']),
    sentimentLabel: (v['sentimentLabel'] as MeetingIntelligence['sentimentLabel']) ?? 'neutral',
    sentimentReason: String(v['sentimentReason'] ?? ''),
    followUpDraft: null,
    sources,
    confidence: result.confidence,
    generatedAt: new Date().toISOString(),
  };

  const sentiment = transcript ? scoreSentiment(transcript.fullText) : 0;

  await ctx.db
    .update(meetings)
    .set({
      intelligence,
      sentiment,
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      processedAt: new Date(),
    })
    .where(eq(meetings.id, meeting.id));

  if (transcript) {
    await indexForSearch(ctx, {
      ownerType: 'transcript',
      ownerId: transcript.id,
      label: `Transcript — ${meeting.title}`,
      text: transcript.fullText,
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      occurredAt: meeting.startsAt,
      metadata: { meetingId: meeting.id },
    });
  }

  await indexForSearch(ctx, {
    ownerType: 'meeting',
    ownerId: meeting.id,
    label: `Meeting — ${meeting.title}`,
    text: [meeting.title, meeting.description ?? '', intelligence.summary].filter(Boolean).join('\n\n'),
    accountId: parties.accountId,
    opportunityId: parties.opportunityId,
    occurredAt: meeting.startsAt,
  });

  await addActivity(ctx, {
    type: 'meeting',
    subjectType: 'account',
    subjectId: parties.accountId ?? meeting.id,
    accountId: parties.accountId,
    opportunityId: parties.opportunityId,
    title: meeting.title,
    summary: intelligence.summary.slice(0, 240),
    direction: 'internal',
    occurredAt: meeting.startsAt,
    sourceType: 'meeting',
    sourceId: meeting.id,
  });

  if (parties.accountId) {
    await addTimelineEvent(ctx, {
      type: 'meeting_happened',
      subjectType: 'account',
      subjectId: parties.accountId,
      accountId: parties.accountId,
      opportunityId: parties.opportunityId,
      title: meeting.title,
      body: intelligence.summary,
      metadata: { participants: participants.length, sentiment: intelligence.sentimentLabel },
      occurredAt: meeting.startsAt,
      sourceType: 'meeting',
      sourceId: meeting.id,
    });
  }

  await runExtraction(ctx, {
    evidence,
    sourceType: transcript ? 'transcript' : 'meeting',
    sourceId: transcript?.id ?? meeting.id,
    accountId: parties.accountId,
    opportunityId: parties.opportunityId,
    contactId: null,
    occurredAt: meeting.startsAt,
    meetingId: meeting.id,
  });

  await touchLastInteraction(ctx, parties, meeting.startsAt);

  await record(ctx, {
    action: 'memory.meeting_processed',
    resourceType: 'meeting',
    resourceId: meeting.id,
    riskLevel: 'low',
    metadata: { commitments: intelligence.nextSteps.length, confidence: result.confidence },
  });

  return intelligence;
}

/* ── Shared extraction ────────────────────────────────────────────────────── */

type ExtractionTarget = {
  evidence: EvidenceItem[];
  sourceType: string;
  sourceId: string;
  accountId: string | null;
  opportunityId: string | null;
  contactId: string | null;
  occurredAt: Date;
  meetingId?: string;
};

async function runExtraction(ctx: Ctx, target: ExtractionTarget): Promise<void> {
  const model = getLanguageModel();
  const knownCompetitors = await workspaceCompetitors(ctx);
  const context = `Known competitors: ${knownCompetitors.join(', ')}`;

  const [commitmentResult, objectionResult, signalResult, factResult] = await Promise.all([
    model.completeStructured<{ commitments: ExtractedCommitmentRow[] }>({
      system: EXTRACTION_SYSTEM,
      instruction: 'Extract every explicit commitment. Who promised what, to whom, by when?',
      schema: commitmentSchema,
      task: 'extract_commitments',
      evidence: target.evidence,
      workspaceContext: context,
    }).catch(emptyResult({ commitments: [] })),
    model.completeStructured<{ objections: { category: string; summary: string; severity: 'low' | 'medium' | 'high'; quote: string; confidence: number }[] }>({
      system: EXTRACTION_SYSTEM,
      instruction: 'Extract concerns, objections and hesitations the customer raised.',
      schema: objectionSchema,
      task: 'extract_objections',
      evidence: target.evidence,
      workspaceContext: context,
    }).catch(emptyResult({ objections: [] })),
    model.completeStructured<{ signals: { category: string; title: string; detail: string; urgency: 'low' | 'medium' | 'high' | 'blocking'; quote: string; confidence: number }[] }>({
      system: EXTRACTION_SYSTEM,
      instruction: 'Extract product requests: features, integrations, security requirements.',
      schema: signalSchema,
      task: 'extract_product_signals',
      evidence: target.evidence,
      workspaceContext: context,
    }).catch(emptyResult({ signals: [] })),
    model.completeStructured<{ facts: { key: string; label: string; valueText?: string; valueNumber?: number; unit?: string; quote: string; confidence: number }[] }>({
      system: EXTRACTION_SYSTEM,
      instruction: 'Extract concrete facts: budget, seats, timeline, decision process.',
      schema: factSchema,
      task: 'extract_facts',
      evidence: target.evidence,
      workspaceContext: context,
    }).catch(emptyResult({ facts: [] })),
  ]);

  await persistCommitments(ctx, commitmentResult.value.commitments ?? [], target);
  await persistObjections(ctx, objectionResult.value.objections ?? [], target);
  await persistSignals(ctx, signalResult.value.signals ?? [], target);
  await persistFacts(ctx, factResult.value.facts ?? [], target);
}

function emptyResult<T>(value: T) {
  return (err: unknown) => {
    console.warn('[memory] extraction step failed, continuing:', (err as Error).message);
    return { value, usage: { promptTokens: 0, completionTokens: 0 }, model: 'none', confidence: 0 };
  };
}

async function persistCommitments(
  ctx: Ctx,
  rows: ExtractedCommitmentRow[],
  target: ExtractionTarget,
): Promise<void> {
  for (const row of rows) {
    if (!row.description || row.confidence < 0.45) continue;

    /**
     * A promise restated across a meeting and its follow-up email is one
     * commitment. Matching on near-identical wording within the same account
     * and direction collapses those, so the same obligation is not counted —
     * or chased — twice.
     */
    const candidates = await ctx.db
      .select({ id: commitments.id, description: commitments.description })
      .from(commitments)
      .where(
        scoped(
          ctx,
          commitments,
          eq(commitments.direction, row.direction),
          target.accountId ? eq(commitments.accountId, target.accountId) : undefined,
          inArray(commitments.status, ['open', 'overdue', 'unconfirmed']),
        ),
      )
      .limit(60);

    const duplicate = candidates.find(
      (c) =>
        c.description.toLowerCase() === row.description.toLowerCase() ||
        overlap(c.description, row.description) >= 0.5,
    );
    if (duplicate) continue;

    const owner = await resolveOwner(ctx, row.ownerLabel, row.direction, target.accountId);

    const [created] = await ctx.db
      .insert(commitments)
      .values({
        workspaceId: ctx.workspaceId,
        description: row.description,
        direction: row.direction,
        ownerLabel: row.ownerLabel,
        ownerUserId: owner.userId,
        ownerContactId: owner.contactId,
        dueAt: parseDueHint(row.dueHint, target.occurredAt),
        status: row.confidence < 0.6 ? 'unconfirmed' : 'open',
        accountId: target.accountId,
        opportunityId: target.opportunityId,
        sourceType: target.sourceType,
        sourceId: target.sourceId,
        sourceQuote: row.quote,
        sourceSegmentIndex: row.segmentIndex != null && row.segmentIndex >= 0 ? row.segmentIndex : null,
        confidence: row.confidence,
      })
      .returning({ id: commitments.id });

    if (target.accountId && created) {
      await addTimelineEvent(ctx, {
        type: 'commitment_made',
        subjectType: 'account',
        subjectId: target.accountId,
        accountId: target.accountId,
        opportunityId: target.opportunityId,
        title: `${row.direction === 'we_owe' ? 'We committed' : 'They committed'}: ${row.description}`,
        body: row.quote,
        metadata: { commitmentId: created.id, confidence: row.confidence },
        occurredAt: target.occurredAt,
        sourceType: target.sourceType,
        sourceId: target.sourceId,
      });
    }
  }
}

async function persistObjections(
  ctx: Ctx,
  rows: { category: string; summary: string; severity: 'low' | 'medium' | 'high'; quote: string; confidence: number }[],
  target: ExtractionTarget,
): Promise<void> {
  for (const row of rows) {
    if (!row.summary || row.confidence < 0.5) continue;

    /**
     * Two-level dedupe.
     *
     * Within a source: key on the summary, not the category. A 40-minute
     * security review legitimately surfaces several distinct security concerns;
     * keying on category alone kept only the first and dropped the rest.
     *
     * Across sources: the same concern restated in a follow-up email is one
     * objection with two pieces of evidence, not two objections. Counting it
     * twice would double-penalise deal health for a single blocker.
     */
    const candidates = await ctx.db
      .select({ id: objections.id, summary: objections.summary })
      .from(objections)
      .where(
        scoped(
          ctx,
          objections,
          eq(objections.category, row.category as never),
          target.accountId ? eq(objections.accountId, target.accountId) : undefined,
          inArray(objections.status, ['open', 'addressed']),
        ),
      )
      .limit(40);

    const duplicate = candidates.find(
      (c) => c.summary.toLowerCase() === row.summary.toLowerCase() || overlap(c.summary, row.summary) >= 0.55,
    );
    if (duplicate) continue;

    const [created] = await ctx.db
      .insert(objections)
      .values({
        workspaceId: ctx.workspaceId,
        category: row.category as never,
        summary: row.summary,
        accountId: target.accountId,
        opportunityId: target.opportunityId,
        contactId: target.contactId,
        severity: row.severity,
        status: 'open',
        sourceType: target.sourceType,
        sourceId: target.sourceId,
        sourceQuote: row.quote,
        confidence: row.confidence,
        occurredAt: target.occurredAt,
      })
      .returning({ id: objections.id });

    if (target.accountId && created) {
      await addTimelineEvent(ctx, {
        type: row.category === 'competitor' ? 'competitor_mentioned' : 'objection_identified',
        subjectType: 'account',
        subjectId: target.accountId,
        accountId: target.accountId,
        opportunityId: target.opportunityId,
        title: `${row.category} concern: ${row.summary}`,
        body: row.quote,
        importance: row.severity === 'high' ? 4 : 3,
        metadata: { objectionId: created.id },
        occurredAt: target.occurredAt,
        sourceType: target.sourceType,
        sourceId: target.sourceId,
      });
    }
  }
}

async function persistSignals(
  ctx: Ctx,
  rows: { category: string; title: string; detail: string; urgency: 'low' | 'medium' | 'high' | 'blocking'; quote: string; confidence: number }[],
  target: ExtractionTarget,
): Promise<void> {
  for (const row of rows) {
    if (!row.title || row.confidence < 0.5) continue;
    const themeId = await ensureTheme(ctx, row.title, row.category);

    const [existing] = await ctx.db
      .select({ id: productSignals.id })
      .from(productSignals)
      .where(
        scoped(
          ctx,
          productSignals,
          eq(productSignals.sourceType, target.sourceType),
          eq(productSignals.sourceId, target.sourceId),
          eq(productSignals.title, row.title),
        ),
      )
      .limit(1);
    if (existing) continue;

    await ctx.db.insert(productSignals).values({
      workspaceId: ctx.workspaceId,
      themeId,
      category: row.category as never,
      title: row.title,
      detail: row.detail,
      accountId: target.accountId,
      contactId: target.contactId,
      opportunityId: target.opportunityId,
      urgency: row.urgency,
      sourceType: target.sourceType,
      sourceId: target.sourceId,
      sourceQuote: row.quote,
      confidence: row.confidence,
      occurredAt: target.occurredAt,
    });

    if (target.accountId) {
      await addTimelineEvent(ctx, {
        type: 'feature_requested',
        subjectType: 'account',
        subjectId: target.accountId,
        accountId: target.accountId,
        opportunityId: target.opportunityId,
        title: `Requested: ${row.title}`,
        body: row.quote,
        importance: row.urgency === 'blocking' ? 4 : 3,
        occurredAt: target.occurredAt,
        sourceType: target.sourceType,
        sourceId: target.sourceId,
      });
    }
  }
}

async function persistFacts(
  ctx: Ctx,
  rows: { key: string; label: string; valueText?: string; valueNumber?: number; unit?: string; quote: string; confidence: number }[],
  target: ExtractionTarget,
): Promise<void> {
  for (const row of rows) {
    if (!row.key || row.confidence < 0.5) continue;

    const subjectType = target.opportunityId ? 'opportunity' : 'account';
    const subjectId = target.opportunityId ?? target.accountId;
    if (!subjectId) continue;

    await recordFact(ctx, {
      subjectType,
      subjectId,
      accountId: target.accountId,
      key: row.key,
      label: row.label,
      valueText: row.valueText && row.valueText.length > 0 ? row.valueText : null,
      valueNumber: row.valueNumber && row.valueNumber !== 0 ? row.valueNumber : null,
      unit: row.unit && row.unit.length > 0 ? row.unit : null,
      confidence: row.confidence,
      source: 'derived',
      sourceType: target.sourceType,
      sourceId: target.sourceId,
      sourceQuote: row.quote,
      validFrom: target.occurredAt,
    });
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

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
    .values({
      workspaceId: ctx.workspaceId,
      name: title,
      category: category as never,
      slug,
    })
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

async function resolveOwner(
  ctx: Ctx,
  label: string,
  direction: 'we_owe' | 'they_owe',
  accountId: string | null,
): Promise<{ userId: string | null; contactId: string | null }> {
  const name = label.trim();
  if (!name || name.length < 3) return { userId: null, contactId: null };

  if (direction === 'they_owe' && accountId) {
    const [contact] = await ctx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        scoped(
          ctx,
          contacts,
          eq(contacts.accountId, accountId),
          sql`similarity(${contacts.firstName} || ' ' || ${contacts.lastName}, ${name}) > 0.4`,
        ),
      )
      .limit(1);
    return { userId: null, contactId: contact?.id ?? null };
  }
  return { userId: null, contactId: null };
}

/** Turn "by Friday" / "next week" into a concrete date relative to the source. */
export function parseDueHint(hint: string | undefined, from: Date): Date | null {
  if (!hint) return null;
  const h = hint.toLowerCase().trim();
  const base = new Date(from);
  const at = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

  if (/\b(today|eod|end of (?:the )?day|cob)\b/.test(h)) return at(base, 0);
  if (/\btomorrow\b/.test(h)) return at(base, 1);
  if (/\b(end of (?:the )?week|eow|this week)\b/.test(h)) return at(base, 5 - base.getDay() || 5);
  if (/\bnext week\b/.test(h)) return at(base, 7);
  if (/\bnext month\b/.test(h)) return at(base, 30);
  if (/\bend of (?:the )?month\b/.test(h)) {
    return new Date(base.getFullYear(), base.getMonth() + 1, 0);
  }
  if (/\bend of (?:the )?quarter\b/.test(h)) {
    return new Date(base.getFullYear(), Math.floor(base.getMonth() / 3) * 3 + 3, 0);
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = weekdays.findIndex((d) => new RegExp(`\\b${d}\\b`).test(h));
  if (dayMatch >= 0) {
    const delta = (dayMatch - base.getDay() + 7) % 7 || 7;
    return at(base, delta);
  }

  const withinDays = /within (\d+)\s*(?:business )?days?/.exec(h);
  if (withinDays?.[1]) return at(base, Number(withinDays[1]));
  const inDays = /in (\d+)\s*days?/.exec(h);
  if (inDays?.[1]) return at(base, Number(inDays[1]));
  const inWeeks = /in (\d+)\s*weeks?/.exec(h);
  if (inWeeks?.[1]) return at(base, Number(inWeeks[1]) * 7);

  return null;
}

async function workspaceCompetitors(ctx: Ctx): Promise<string[]> {
  const [row] = await ctx.db
    .select({ companyContext: sql<{ competitors?: string[] } | null>`company_context` })
    .from(sql`workspaces`)
    .where(sql`id = ${ctx.workspaceId}`)
    .limit(1);
  return row?.companyContext?.competitors ?? [];
}

async function touchLastInteraction(ctx: Ctx, parties: ResolvedParties, when: Date): Promise<void> {
  if (parties.accountId) {
    await ctx.db
      .update(accounts)
      .set({ lastInteractionAt: sql`GREATEST(COALESCE(${accounts.lastInteractionAt}, to_timestamp(0)), ${when})` })
      .where(and(scope(ctx, accounts), eq(accounts.id, parties.accountId)));
  }
  if (parties.opportunityId) {
    await ctx.db
      .update(opportunities)
      .set({ lastInteractionAt: sql`GREATEST(COALESCE(${opportunities.lastInteractionAt}, to_timestamp(0)), ${when})` })
      .where(and(scope(ctx, opportunities), eq(opportunities.id, parties.opportunityId)));
  }
  for (const contactId of parties.contactIds) {
    await ctx.db
      .update(contacts)
      .set({ lastInteractionAt: sql`GREATEST(COALESCE(${contacts.lastInteractionAt}, to_timestamp(0)), ${when})` })
      .where(and(scope(ctx, contacts), eq(contacts.id, contactId)));
  }
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}
