import { and, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  crmEvents,
  emails,
  embeddings,
  knowledgeChunks,
  knowledgeDocuments,
  meetings,
  notes,
  objections,
  opportunities,
  productSignals,
  transcripts,
  type SourceRef,
} from '@/db/schema';
import type { EvidenceItem } from '@/lib/ai/types';
import { toVectorLiteral } from '@/lib/ai/embeddings';
import { getEmbeddingModel } from '@/lib/ai';
import { nameSimilarity, recencyWeight, tokenize } from '@/lib/ai/local/nlp';
import { scope, scoped, type Ctx } from '../context';

/**
 * Hybrid retrieval.
 *
 * The rule this enforces is "never send an entire company's CRM to a model".
 * Context is assembled per question:
 *
 *   1. resolve entities named in the question to real record ids
 *   2. run structured SQL filters (owner, stage, value, recency)
 *   3. run lexical search  (Postgres ts_rank over generated tsvectors)
 *   4. run semantic search (pgvector cosine over the embeddings table)
 *   5. fuse 3+4 with Reciprocal Rank Fusion, then weight by recency
 *   6. truncate to a token budget
 *
 * RRF is used rather than score averaging because ts_rank and cosine distance
 * are not commensurable — fusing on *rank* avoids one scale swamping the other.
 */

export type SearchScope =
  | 'accounts'
  | 'contacts'
  | 'opportunities'
  | 'emails'
  | 'meetings'
  | 'transcripts'
  | 'notes'
  | 'tasks'
  | 'commitments'
  | 'objections'
  | 'product_signals'
  | 'crm_events'
  | 'knowledge';

export type SearchOptions = {
  query: string;
  scopes?: SearchScope[];
  accountId?: string;
  opportunityId?: string;
  contactId?: string;
  /** Only consider records newer than this many days. 0 = no limit. */
  sinceDays?: number;
  limit?: number;
  /** Skip the vector leg — used by fast paths that only need lexical hits. */
  lexicalOnly?: boolean;
  /**
   * Also pull this many of the most recent conversations for the scoped
   * account/opportunity, regardless of term match.
   *
   * Summarisation needs this. "Summarise the Acme deal" has no useful search
   * terms — the words that matter ("our goal is to go live by Q3") are exactly
   * the ones the query cannot predict. Keyword relevance is the wrong lens for
   * "tell me about this record"; recency is the right one.
   */
  includeRecent?: number;
};

const DEFAULT_SCOPES: SearchScope[] = [
  'accounts',
  'opportunities',
  'emails',
  'meetings',
  'transcripts',
  'notes',
  'commitments',
  'objections',
];

export type ResolvedEntities = {
  accounts: { id: string; name: string }[];
  contacts: { id: string; name: string; accountId: string | null }[];
  opportunities: { id: string; name: string; accountId: string }[];
};

/**
 * Find records a question names directly.
 *
 * Trigram similarity handles "Acme" → "Acme Corporation" and typos. Matching
 * only on capitalised spans would miss lowercase queries, so candidates are
 * drawn from the workspace and scored rather than pattern-matched out of the
 * question text.
 */
export async function resolveEntities(ctx: Ctx, query: string): Promise<ResolvedEntities> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { accounts: [], contacts: [], opportunities: [] };

  const [accountRows, contactRows, oppRows] = await Promise.all([
    ctx.db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(
        and(
          scope(ctx, accounts),
          sql`similarity(${accounts.name}, ${trimmed}) > 0.28
              OR ${trimmed} ILIKE '%' || ${accounts.name} || '%'`,
        ),
      )
      .orderBy(sql`similarity(${accounts.name}, ${trimmed}) DESC`)
      .limit(5),
    ctx.db
      .select({ id: contacts.id, name: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`, accountId: contacts.accountId })
      .from(contacts)
      .where(
        and(
          scope(ctx, contacts),
          sql`similarity(${contacts.firstName} || ' ' || ${contacts.lastName}, ${trimmed}) > 0.32
              OR ${trimmed} ILIKE '%' || ${contacts.firstName} || ' ' || ${contacts.lastName} || '%'`,
        ),
      )
      .limit(5),
    ctx.db
      .select({ id: opportunities.id, name: opportunities.name, accountId: opportunities.accountId })
      .from(opportunities)
      .where(
        and(
          scope(ctx, opportunities),
          sql`similarity(${opportunities.name}, ${trimmed}) > 0.3
              OR ${trimmed} ILIKE '%' || ${opportunities.name} || '%'`,
        ),
      )
      .limit(5),
  ]);

  // Guard against a short query fuzzily matching an unrelated long name.
  const keep = <T extends { name: string }>(rows: T[]) =>
    rows.filter((r) => nameSimilarity(r.name, trimmed) > 0.25 || trimmed.toLowerCase().includes(r.name.toLowerCase()));

  return {
    accounts: keep(accountRows),
    contacts: keep(contactRows),
    opportunities: keep(oppRows),
  };
}

type Candidate = {
  ref: SourceRef;
  content: string;
  trust: 'trusted' | 'untrusted';
  occurredAt: Date | null;
  accountId: string | null;
  metadata?: Record<string, unknown>;
  lexicalRank?: number;
  vectorRank?: number;
};

/** The main entry point. Returns ranked, citation-ready evidence. */
export async function search(ctx: Ctx, options: SearchOptions): Promise<EvidenceItem[]> {
  const scopes = options.scopes?.length ? options.scopes : DEFAULT_SCOPES;
  const limit = options.limit ?? 12;
  const since =
    options.sinceDays && options.sinceDays > 0
      ? new Date(Date.now() - options.sinceDays * 86_400_000)
      : undefined;

  const entities = await resolveEntities(ctx, options.query);
  const accountId = options.accountId ?? entities.accounts[0]?.id ?? entities.contacts[0]?.accountId ?? undefined;
  const opportunityId = options.opportunityId ?? entities.opportunities[0]?.id;

  const [lexical, semantic] = await Promise.all([
    lexicalSearch(ctx, { ...options, scopes, accountId, opportunityId, since }),
    options.lexicalOnly
      ? Promise.resolve([] as Candidate[])
      : semanticSearch(ctx, { ...options, scopes, accountId, opportunityId, since }),
  ]);

  const fused = fuse(lexical, semantic);
  const [structural, recent] = await Promise.all([
    structuralContext(ctx, { accountId, opportunityId, scopes }),
    options.includeRecent && (accountId || opportunityId)
      ? recentConversations(ctx, { accountId, opportunityId, limit: options.includeRecent })
      : Promise.resolve([] as (Candidate & { fusedScore: number })[]),
  ]);

  const all = dedupeByRef([...structural, ...recent, ...fused]);

  return all
    .map((c) => ({
      ref: c.ref,
      content: c.content,
      trust: c.trust,
      metadata: c.metadata,
      score: rankScore(c),
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

function rankScore(c: Candidate & { fusedScore?: number }): number {
  const base = c.fusedScore ?? 0.35;
  return Number((base * recencyWeight(c.occurredAt)).toFixed(4));
}

/* ── Lexical leg ──────────────────────────────────────────────────────────── */

type LegOptions = SearchOptions & {
  scopes: SearchScope[];
  accountId?: string;
  opportunityId?: string;
  since?: Date;
};

/**
 * Build a tsquery with OR semantics.
 *
 * `websearch_to_tsquery` ANDs every word, which is right for a search box and
 * badly wrong for a question: "what is blocking the Acme deal?" would require
 * every one of those words in a single document and match nothing. Joining the
 * significant terms with `or` lets `ts_rank` do the discriminating — documents
 * containing more of the terms simply score higher.
 */
function buildTsQuery(query: string): { sql: ReturnType<typeof sql>; terms: string[] } | null {
  const terms = [...new Set(tokenize(query))].filter((t) => t.length > 2).slice(0, 24);
  if (terms.length === 0) return null;
  // Terms are already stripped to [a-z0-9] by `tokenize`, and are passed as a
  // bound parameter regardless — no injection surface here.
  return { sql: sql`websearch_to_tsquery('english', ${terms.join(' or ')})`, terms };
}

async function lexicalSearch(ctx: Ctx, opts: LegOptions): Promise<Candidate[]> {
  const built = buildTsQuery(opts.query);
  if (!built) return [];
  const tsquery = built.sql;
  const perScope = Math.max(4, Math.ceil((opts.limit ?? 12) / 2));
  const out: Candidate[] = [];

  const jobs: Promise<Candidate[]>[] = [];

  if (opts.scopes.includes('emails')) {
    jobs.push(
      ctx.db
        .select({
          id: emails.id,
          subject: emails.subject,
          body: emails.bodyText,
          sentAt: emails.sentAt,
          accountId: emails.accountId,
          fromName: emails.fromName,
          fromEmail: emails.fromEmail,
          direction: emails.direction,
          rank: sql<number>`ts_rank(${emails.searchVector}, ${tsquery})`,
        })
        .from(emails)
        .where(
          scoped(
            ctx,
            emails,
            sql`${emails.searchVector} @@ ${tsquery}`,
            opts.accountId ? eq(emails.accountId, opts.accountId) : undefined,
            opts.opportunityId ? eq(emails.opportunityId, opts.opportunityId) : undefined,
            opts.since ? gte(emails.sentAt, opts.since) : undefined,
          ),
        )
        .orderBy(sql`ts_rank(${emails.searchVector}, ${tsquery}) DESC`)
        .limit(perScope)
        .then((rows) =>
          rows.map((r) => ({
            ref: {
              type: 'email' as const,
              id: r.id,
              label: `Email — ${r.subject}`,
              occurredAt: r.sentAt.toISOString(),
              snippet: r.body.slice(0, 180),
            },
            content: `From: ${r.fromName ?? r.fromEmail} (${r.direction})\nSubject: ${r.subject}\n\n${r.body}`,
            trust: 'untrusted' as const,
            occurredAt: r.sentAt,
            accountId: r.accountId,
            metadata: { isCustomer: r.direction === 'inbound', speaker: r.fromName ?? r.fromEmail },
          })),
        ),
    );
  }

  if (opts.scopes.includes('meetings')) {
    jobs.push(
      ctx.db
        .select({
          id: meetings.id,
          title: meetings.title,
          description: meetings.description,
          startsAt: meetings.startsAt,
          accountId: meetings.accountId,
          intelligence: meetings.intelligence,
          rank: sql<number>`ts_rank(${meetings.searchVector}, ${tsquery})`,
        })
        .from(meetings)
        .where(
          scoped(
            ctx,
            meetings,
            sql`${meetings.searchVector} @@ ${tsquery}`,
            opts.accountId ? eq(meetings.accountId, opts.accountId) : undefined,
            opts.opportunityId ? eq(meetings.opportunityId, opts.opportunityId) : undefined,
            opts.since ? gte(meetings.startsAt, opts.since) : undefined,
          ),
        )
        .orderBy(sql`ts_rank(${meetings.searchVector}, ${tsquery}) DESC`)
        .limit(perScope)
        .then((rows) =>
          rows.map((r) => ({
            ref: {
              type: 'meeting' as const,
              id: r.id,
              label: `Meeting — ${r.title}`,
              occurredAt: r.startsAt.toISOString(),
            },
            content: [r.title, r.description ?? '', r.intelligence?.summary ?? ''].filter(Boolean).join('\n\n'),
            trust: 'untrusted' as const,
            occurredAt: r.startsAt,
            accountId: r.accountId,
          })),
        ),
    );
  }

  if (opts.scopes.includes('transcripts')) {
    jobs.push(
      ctx.db
        .select({
          id: transcripts.id,
          meetingId: transcripts.meetingId,
          fullText: transcripts.fullText,
          title: meetings.title,
          startsAt: meetings.startsAt,
          accountId: meetings.accountId,
          rank: sql<number>`ts_rank(${transcripts.searchVector}, ${tsquery})`,
        })
        .from(transcripts)
        .leftJoin(meetings, eq(meetings.id, transcripts.meetingId))
        .where(
          scoped(
            ctx,
            transcripts,
            sql`${transcripts.searchVector} @@ ${tsquery}`,
            opts.accountId ? eq(meetings.accountId, opts.accountId) : undefined,
            opts.opportunityId ? eq(meetings.opportunityId, opts.opportunityId) : undefined,
          ),
        )
        .orderBy(sql`ts_rank(${transcripts.searchVector}, ${tsquery}) DESC`)
        .limit(perScope)
        .then((rows) =>
          rows.map((r) => ({
            ref: {
              type: 'transcript' as const,
              id: r.id,
              label: `Transcript — ${r.title ?? 'Meeting'}`,
              occurredAt: r.startsAt?.toISOString(),
            },
            // Transcripts are long; the composer selects sentences from this.
            content: r.fullText.slice(0, 12_000),
            trust: 'untrusted' as const,
            occurredAt: r.startsAt,
            accountId: r.accountId,
            metadata: { meetingId: r.meetingId },
          })),
        ),
    );
  }

  if (opts.scopes.includes('notes')) {
    jobs.push(
      ctx.db
        .select({
          id: notes.id,
          body: notes.body,
          createdAt: notes.createdAt,
          accountId: notes.accountId,
          rank: sql<number>`ts_rank(${notes.searchVector}, ${tsquery})`,
        })
        .from(notes)
        .where(
          scoped(
            ctx,
            notes,
            sql`${notes.searchVector} @@ ${tsquery}`,
            opts.accountId ? eq(notes.accountId, opts.accountId) : undefined,
          ),
        )
        .orderBy(sql`ts_rank(${notes.searchVector}, ${tsquery}) DESC`)
        .limit(perScope)
        .then((rows) =>
          rows.map((r) => ({
            ref: {
              type: 'note' as const,
              id: r.id,
              label: 'Internal note',
              occurredAt: r.createdAt.toISOString(),
            },
            content: r.body,
            // Notes are written by colleagues, not customers.
            trust: 'trusted' as const,
            occurredAt: r.createdAt,
            accountId: r.accountId,
          })),
        ),
    );
  }

  if (opts.scopes.includes('knowledge')) {
    jobs.push(
      ctx.db
        .select({
          id: knowledgeChunks.id,
          documentId: knowledgeChunks.documentId,
          content: knowledgeChunks.content,
          heading: knowledgeChunks.heading,
          title: knowledgeDocuments.title,
          rank: sql<number>`ts_rank(${knowledgeChunks.searchVector}, ${tsquery})`,
        })
        .from(knowledgeChunks)
        .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
        .where(
          and(
            scope(ctx, knowledgeChunks),
            isNull(knowledgeDocuments.deletedAt),
            sql`${knowledgeChunks.searchVector} @@ ${tsquery}`,
          ),
        )
        .orderBy(sql`ts_rank(${knowledgeChunks.searchVector}, ${tsquery}) DESC`)
        .limit(perScope)
        .then((rows) =>
          rows.map((r) => ({
            ref: {
              type: 'knowledge' as const,
              id: r.documentId,
              label: `${r.title}${r.heading ? ` — ${r.heading}` : ''}`,
            },
            content: r.content,
            // Workspace-authored knowledge is trusted configuration.
            trust: 'trusted' as const,
            occurredAt: null,
            accountId: null,
          })),
        ),
    );
  }

  const results = await Promise.all(jobs);
  for (const set of results) out.push(...set);

  return out
    .sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0))
    .map((c, i) => ({ ...c, lexicalRank: i + 1 }));
}

/* ── Semantic leg ─────────────────────────────────────────────────────────── */

async function semanticSearch(ctx: Ctx, opts: LegOptions): Promise<Candidate[]> {
  const embedder = getEmbeddingModel();
  const [vector] = await embedder.embed([opts.query]);
  if (!vector) return [];
  const literal = toVectorLiteral(vector);

  const ownerTypes = scopesToOwnerTypes(opts.scopes);
  if (ownerTypes.length === 0) return [];

  const rows = await ctx.db
    .select({
      id: embeddings.id,
      ownerType: embeddings.ownerType,
      ownerId: embeddings.ownerId,
      content: embeddings.content,
      occurredAt: embeddings.occurredAt,
      accountId: embeddings.accountId,
      metadata: embeddings.metadata,
      distance: sql<number>`${embeddings.embedding} <=> ${literal}::vector`,
    })
    .from(embeddings)
    .where(
      scoped(
        ctx,
        embeddings,
        inArray(embeddings.ownerType, ownerTypes),
        opts.accountId ? eq(embeddings.accountId, opts.accountId) : undefined,
        opts.opportunityId ? eq(embeddings.opportunityId, opts.opportunityId) : undefined,
        opts.since ? gte(embeddings.occurredAt, opts.since) : undefined,
        sql`${embeddings.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${embeddings.embedding} <=> ${literal}::vector`)
    .limit(Math.max(10, (opts.limit ?? 12) * 2));

  return rows.map((r, i) => ({
    ref: {
      type: ownerTypeToRefType(r.ownerType),
      id: r.ownerId,
      label: typeof r.metadata?.['label'] === 'string' ? (r.metadata['label'] as string) : r.ownerType,
      occurredAt: r.occurredAt?.toISOString(),
      snippet: r.content.slice(0, 180),
    },
    content: r.content,
    trust: r.ownerType === 'knowledge' || r.ownerType === 'note' ? ('trusted' as const) : ('untrusted' as const),
    occurredAt: r.occurredAt,
    accountId: r.accountId,
    metadata: r.metadata ?? undefined,
    vectorRank: i + 1,
  }));
}

function scopesToOwnerTypes(scopes: SearchScope[]): string[] {
  const map: Partial<Record<SearchScope, string>> = {
    emails: 'email',
    meetings: 'meeting',
    transcripts: 'transcript',
    notes: 'note',
    knowledge: 'knowledge',
    accounts: 'account',
    opportunities: 'opportunity',
    contacts: 'contact',
  };
  return scopes.map((s) => map[s]).filter((x): x is string => Boolean(x));
}

function ownerTypeToRefType(ownerType: string): SourceRef['type'] {
  const allowed: SourceRef['type'][] = [
    'email',
    'meeting',
    'transcript',
    'note',
    'call',
    'task',
    'commitment',
    'crm_event',
    'memory_fact',
    'knowledge',
    'opportunity',
    'account',
    'contact',
  ];
  return (allowed as string[]).includes(ownerType) ? (ownerType as SourceRef['type']) : 'crm_event';
}

/* ── Fusion ───────────────────────────────────────────────────────────────── */

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank). Robust to the two legs having
 * wildly different score distributions, and needs no tuning per corpus.
 */
function fuse(lexical: Candidate[], semantic: Candidate[]): (Candidate & { fusedScore: number })[] {
  const byKey = new Map<string, Candidate & { fusedScore: number }>();

  const add = (c: Candidate, rank: number, weight: number) => {
    const key = `${c.ref.type}:${c.ref.id}`;
    const contribution = weight * (1 / (RRF_K + rank));
    const existing = byKey.get(key);
    if (existing) {
      existing.fusedScore += contribution;
      // Prefer the longer rendering of the same record.
      if (c.content.length > existing.content.length) existing.content = c.content;
      existing.metadata = { ...existing.metadata, ...c.metadata };
    } else {
      byKey.set(key, { ...c, fusedScore: contribution });
    }
  };

  lexical.forEach((c, i) => add(c, c.lexicalRank ?? i + 1, 1.0));
  // Lexical is weighted slightly higher: exact terms like "SOC 2" or a person's
  // name are usually what the user meant, and the local embedder is lexical-ish
  // by construction.
  semantic.forEach((c, i) => add(c, c.vectorRank ?? i + 1, 0.85));

  return [...byKey.values()].sort((a, b) => b.fusedScore - a.fusedScore);
}

function dedupeByRef(candidates: (Candidate & { fusedScore?: number })[]) {
  const seen = new Map<string, Candidate & { fusedScore?: number }>();
  for (const c of candidates) {
    const key = `${c.ref.type}:${c.ref.id}`;
    const existing = seen.get(key);
    if (!existing || (c.fusedScore ?? 0) > (existing.fusedScore ?? 0)) {
      seen.set(key, { ...existing, ...c, fusedScore: Math.max(c.fusedScore ?? 0, existing?.fusedScore ?? 0) });
    }
  }
  return [...seen.values()];
}

/* ── Recency leg ──────────────────────────────────────────────────────────── */

/**
 * The most recent conversations on a record, ignoring the query entirely.
 *
 * Scored just above the structural rows and below a genuine lexical hit, so a
 * term match still wins when there is one — this only ensures the record's own
 * recent history is never absent from its summary.
 */
async function recentConversations(
  ctx: Ctx,
  opts: { accountId?: string; opportunityId?: string; limit: number },
): Promise<(Candidate & { fusedScore: number })[]> {
  const scopeFilter = <T extends { accountId: PgColumnLike; opportunityId: PgColumnLike }>(t: T) =>
    opts.opportunityId
      ? eq(t.opportunityId as never, opts.opportunityId)
      : eq(t.accountId as never, opts.accountId!);

  const [emailRows, meetingRows, noteRows] = await Promise.all([
    ctx.db
      .select({
        id: emails.id,
        subject: emails.subject,
        body: emails.bodyText,
        sentAt: emails.sentAt,
        accountId: emails.accountId,
        direction: emails.direction,
        fromName: emails.fromName,
        fromEmail: emails.fromEmail,
      })
      .from(emails)
      .where(scoped(ctx, emails, scopeFilter(emails)))
      .orderBy(desc(emails.sentAt))
      .limit(opts.limit),
    ctx.db
      .select({
        id: transcripts.id,
        fullText: transcripts.fullText,
        title: meetings.title,
        startsAt: meetings.startsAt,
        accountId: meetings.accountId,
      })
      .from(transcripts)
      .innerJoin(meetings, eq(meetings.id, transcripts.meetingId))
      .where(and(scope(ctx, transcripts), scopeFilter(meetings)))
      .orderBy(desc(meetings.startsAt))
      .limit(opts.limit),
    ctx.db
      .select({ id: notes.id, body: notes.body, createdAt: notes.createdAt, accountId: notes.accountId })
      .from(notes)
      .where(scoped(ctx, notes, scopeFilter(notes)))
      .orderBy(desc(notes.createdAt))
      .limit(4),
  ]);

  const out: (Candidate & { fusedScore: number })[] = [];

  for (const r of emailRows) {
    out.push({
      ref: {
        type: 'email',
        id: r.id,
        label: `Email — ${r.subject}`,
        occurredAt: r.sentAt.toISOString(),
        snippet: r.body.slice(0, 180),
      },
      content: `From: ${r.fromName ?? r.fromEmail} (${r.direction})\nSubject: ${r.subject}\n\n${r.body}`,
      trust: 'untrusted',
      occurredAt: r.sentAt,
      accountId: r.accountId,
      metadata: { isCustomer: r.direction === 'inbound', speaker: r.fromName ?? r.fromEmail },
      fusedScore: 0.07,
    });
  }

  for (const r of meetingRows) {
    out.push({
      ref: {
        type: 'transcript',
        id: r.id,
        label: `Transcript — ${r.title}`,
        occurredAt: r.startsAt.toISOString(),
      },
      content: r.fullText.slice(0, 12_000),
      trust: 'untrusted',
      occurredAt: r.startsAt,
      accountId: r.accountId,
      fusedScore: 0.075,
    });
  }

  for (const r of noteRows) {
    out.push({
      ref: { type: 'note', id: r.id, label: 'Internal note', occurredAt: r.createdAt.toISOString() },
      content: r.body,
      trust: 'trusted',
      occurredAt: r.createdAt,
      accountId: r.accountId,
      fusedScore: 0.065,
    });
  }

  return out;
}

type PgColumnLike = Parameters<typeof eq>[0];

/* ── Structural context ───────────────────────────────────────────────────── */

/**
 * Records pulled in because of *what* the question is about rather than word
 * overlap: the account's own fields, its open commitments, its live objections.
 * These matter even when the question's wording never mentions them.
 */
async function structuralContext(
  ctx: Ctx,
  opts: { accountId?: string; opportunityId?: string; scopes: SearchScope[] },
): Promise<(Candidate & { fusedScore: number })[]> {
  if (!opts.accountId && !opts.opportunityId) return [];
  const out: (Candidate & { fusedScore: number })[] = [];

  if (opts.accountId) {
    const [account] = await ctx.db
      .select()
      .from(accounts)
      .where(and(scope(ctx, accounts), eq(accounts.id, opts.accountId)))
      .limit(1);

    if (account) {
      out.push({
        ref: { type: 'account', id: account.id, label: `Account — ${account.name}` },
        content: renderAccount(account),
        trust: 'trusted',
        occurredAt: account.lastInteractionAt,
        accountId: account.id,
        fusedScore: 0.05,
      });
    }
  }

  if (opts.opportunityId) {
    const [opp] = await ctx.db
      .select()
      .from(opportunities)
      .where(and(scope(ctx, opportunities), eq(opportunities.id, opts.opportunityId)))
      .limit(1);
    if (opp) {
      out.push({
        ref: { type: 'opportunity', id: opp.id, label: `Deal — ${opp.name}` },
        content: renderOpportunity(opp),
        trust: 'trusted',
        occurredAt: opp.lastInteractionAt,
        accountId: opp.accountId,
        fusedScore: 0.055,
      });
    }
  }

  if (opts.scopes.includes('commitments')) {
    const rows = await ctx.db
      .select()
      .from(commitments)
      .where(
        scoped(
          ctx,
          commitments,
          opts.accountId ? eq(commitments.accountId, opts.accountId) : undefined,
          opts.opportunityId ? eq(commitments.opportunityId, opts.opportunityId) : undefined,
          inArray(commitments.status, ['open', 'overdue']),
        ),
      )
      .limit(8);

    for (const row of rows) {
      out.push({
        ref: {
          type: 'commitment',
          id: row.id,
          label: `Commitment — ${row.direction === 'we_owe' ? 'we owe' : 'they owe'}`,
          occurredAt: row.createdAt.toISOString(),
        },
        content: `${row.ownerLabel} — ${row.description}${row.dueAt ? ` (due ${row.dueAt.toISOString().slice(0, 10)})` : ''}\nSource quote: "${row.sourceQuote ?? ''}"`,
        trust: 'trusted',
        occurredAt: row.dueAt ?? row.createdAt,
        accountId: row.accountId,
        fusedScore: 0.045,
      });
    }
  }

  if (opts.scopes.includes('objections')) {
    const rows = await ctx.db
      .select()
      .from(objections)
      .where(
        scoped(
          ctx,
          objections,
          opts.accountId ? eq(objections.accountId, opts.accountId) : undefined,
          opts.opportunityId ? eq(objections.opportunityId, opts.opportunityId) : undefined,
          inArray(objections.status, ['open', 'addressed']),
        ),
      )
      .limit(8);

    for (const row of rows) {
      out.push({
        ref: {
          type: 'crm_event',
          id: row.id,
          label: `Objection — ${row.category}`,
          occurredAt: row.occurredAt.toISOString(),
        },
        content: `${row.summary}\nSeverity: ${row.severity}. Status: ${row.status}.\nSource quote: "${row.sourceQuote ?? ''}"`,
        trust: 'trusted',
        occurredAt: row.occurredAt,
        accountId: row.accountId,
        fusedScore: 0.048,
      });
    }
  }

  return out;
}

function renderAccount(a: typeof accounts.$inferSelect): string {
  return [
    `Name: ${a.name}`,
    a.industry ? `Industry: ${a.industry}` : null,
    a.employeeCount ? `Employees: ${a.employeeCount}` : null,
    a.currentArr ? `Current ARR: $${a.currentArr.toLocaleString()}` : null,
    `Lifecycle: ${a.lifecycleStage}`,
    a.healthScore != null ? `Health: ${a.healthScore}/100` : null,
    a.lastInteractionAt ? `Last interaction: ${a.lastInteractionAt.toISOString().slice(0, 10)}` : null,
    a.description ? `About: ${a.description}` : null,
    a.memorySummary?.relationship ? `Relationship: ${a.memorySummary.relationship}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderOpportunity(o: typeof opportunities.$inferSelect): string {
  return [
    `Deal: ${o.name}`,
    `Value: $${o.value.toLocaleString()} ${o.currency}`,
    `Status: ${o.status}`,
    o.expectedCloseDate ? `Expected close: ${o.expectedCloseDate.toISOString().slice(0, 10)}` : null,
    o.healthScore != null ? `Health: ${o.healthScore}/100` : null,
    `In current stage since: ${o.stageEnteredAt.toISOString().slice(0, 10)}`,
    o.lastInteractionAt ? `Last interaction: ${o.lastInteractionAt.toISOString().slice(0, 10)}` : null,
    o.memorySummary?.whyBuying ? `Why buying: ${o.memorySummary.whyBuying}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
