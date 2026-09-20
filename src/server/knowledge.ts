import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { knowledgeChunks, knowledgeDocuments, users } from '@/db/schema';
import { getEmbeddingModel } from '@/lib/ai';
import { chunkText, toVectorLiteral } from '@/lib/ai/embeddings';
import { NotFoundError, scope, scoped, ValidationError, type Ctx } from './context';
import { ctxAssert } from './context';
import { record } from './audit';
import { indexForSearch } from './memory/ingest';

/**
 * The knowledge base.
 *
 * Knowledge is *trusted workspace configuration*, unlike customer email or
 * transcripts. That distinction is load-bearing: agents may follow guidance
 * from a playbook, and must never follow instructions found in a customer's
 * message. The `trusted` flag is what the prompt builder reads to decide
 * whether content is fenced as untrusted data.
 */

export type KnowledgeFilters = { query?: string; category?: string; limit?: number };

export async function listKnowledge(ctx: Ctx, filters: KnowledgeFilters = {}) {
  return ctx.db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      category: knowledgeDocuments.category,
      summary: knowledgeDocuments.summary,
      tags: knowledgeDocuments.tags,
      trusted: knowledgeDocuments.trusted,
      version: knowledgeDocuments.version,
      indexedAt: knowledgeDocuments.indexedAt,
      updatedAt: knowledgeDocuments.updatedAt,
      uploadedByName: users.name,
      chunkCount: sql<number>`(
        SELECT count(*)::int FROM knowledge_chunks kc WHERE kc.document_id = ${knowledgeDocuments.id}
      )`,
      wordCount: sql<number>`array_length(regexp_split_to_array(trim(${knowledgeDocuments.content}), '\\s+'), 1)`,
    })
    .from(knowledgeDocuments)
    .leftJoin(users, eq(users.id, knowledgeDocuments.uploadedById))
    .where(
      scoped(
        ctx,
        knowledgeDocuments,
        filters.query
          ? sql`(${knowledgeDocuments.title} ILIKE ${`%${filters.query}%`}
                 OR ${knowledgeDocuments.content} ILIKE ${`%${filters.query}%`})`
          : undefined,
        filters.category ? eq(knowledgeDocuments.category, filters.category as never) : undefined,
      ),
    )
    .orderBy(knowledgeDocuments.category, knowledgeDocuments.title)
    .limit(filters.limit ?? 100);
}

export async function getKnowledgeDocument(ctx: Ctx, documentId: string) {
  const [document] = await ctx.db
    .select({
      document: knowledgeDocuments,
      uploadedByName: users.name,
    })
    .from(knowledgeDocuments)
    .leftJoin(users, eq(users.id, knowledgeDocuments.uploadedById))
    .where(and(scope(ctx, knowledgeDocuments), eq(knowledgeDocuments.id, documentId)))
    .limit(1);

  if (!document) throw new NotFoundError('Document', documentId);

  const chunks = await ctx.db
    .select({
      id: knowledgeChunks.id,
      chunkIndex: knowledgeChunks.chunkIndex,
      heading: knowledgeChunks.heading,
      tokenCount: knowledgeChunks.tokenCount,
    })
    .from(knowledgeChunks)
    .where(scoped(ctx, knowledgeChunks, eq(knowledgeChunks.documentId, documentId)))
    .orderBy(knowledgeChunks.chunkIndex);

  return { document: document.document, uploadedByName: document.uploadedByName, chunks };
}

export type SaveKnowledgeInput = {
  id?: string;
  title: string;
  category:
    | 'product'
    | 'pricing'
    | 'security'
    | 'playbook'
    | 'case_study'
    | 'battlecard'
    | 'methodology'
    | 'onboarding'
    | 'other';
  content: string;
  tags?: string[];
};

/**
 * Create or replace a document, then re-index it.
 *
 * Chunks are deleted and rebuilt rather than diffed: an edit that shortens a
 * document must not leave stale chunks behind that retrieval could still
 * surface as current guidance.
 */
export async function saveKnowledge(ctx: Ctx, input: SaveKnowledgeInput): Promise<string> {
  ctxAssert(ctx, 'knowledge:manage');

  if (input.content.trim().length < 40) {
    throw new ValidationError('The document needs some actual content to be useful to an agent.');
  }

  const summary =
    input.content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 40 && !line.startsWith('#'))
      ?.slice(0, 240) ?? null;

  let documentId = input.id ?? null;

  if (documentId) {
    const [existing] = await ctx.db
      .select({ version: knowledgeDocuments.version })
      .from(knowledgeDocuments)
      .where(and(scope(ctx, knowledgeDocuments), eq(knowledgeDocuments.id, documentId)))
      .limit(1);
    if (!existing) throw new NotFoundError('Document', documentId);

    await ctx.db
      .update(knowledgeDocuments)
      .set({
        title: input.title,
        category: input.category,
        content: input.content,
        summary,
        tags: input.tags ?? [],
        version: existing.version + 1,
        indexedAt: new Date(),
      })
      .where(and(scope(ctx, knowledgeDocuments), eq(knowledgeDocuments.id, documentId)));
  } else {
    const [created] = await ctx.db
      .insert(knowledgeDocuments)
      .values({
        workspaceId: ctx.workspaceId,
        title: input.title,
        category: input.category,
        content: input.content,
        summary,
        tags: input.tags ?? [],
        trusted: true,
        uploadedById: ctx.userId,
        indexedAt: new Date(),
      })
      .returning({ id: knowledgeDocuments.id });
    documentId = created!.id;
  }

  await reindexDocument(ctx, documentId, input.title, input.content);

  await record(ctx, {
    action: input.id ? 'knowledge.updated' : 'knowledge.created',
    resourceType: 'knowledge_document',
    resourceId: documentId,
    riskLevel: 'medium',
    metadata: { title: input.title, category: input.category },
  });

  return documentId;
}

async function reindexDocument(ctx: Ctx, documentId: string, title: string, content: string) {
  await ctx.db
    .delete(knowledgeChunks)
    .where(and(scope(ctx, knowledgeChunks), eq(knowledgeChunks.documentId, documentId)));

  const chunks = chunkText(content, { maxChars: 1200 });
  const embedder = getEmbeddingModel();
  const vectors = await embedder.embed(chunks.map((c) => c.content));

  for (const [i, chunk] of chunks.entries()) {
    const vector = vectors[i];
    await ctx.db.insert(knowledgeChunks).values({
      workspaceId: ctx.workspaceId,
      documentId,
      chunkIndex: chunk.index,
      heading: /^#{1,3}\s+(.+)$/m.exec(chunk.content)?.[1]?.trim() ?? null,
      content: chunk.content,
      embedding: vector ? (sql`${toVectorLiteral(vector)}::vector` as never) : null,
      tokenCount: Math.ceil(chunk.content.length / 3.6),
    });
  }

  await indexForSearch(ctx, {
    ownerType: 'knowledge',
    ownerId: documentId,
    label: title,
    text: content,
  });
}

export async function deleteKnowledge(ctx: Ctx, documentId: string) {
  ctxAssert(ctx, 'knowledge:manage');

  await ctx.db
    .update(knowledgeDocuments)
    .set({ deletedAt: new Date() })
    .where(and(scope(ctx, knowledgeDocuments), eq(knowledgeDocuments.id, documentId)));

  // Chunks must go too, or retrieval keeps citing a deleted document.
  await ctx.db
    .delete(knowledgeChunks)
    .where(and(scope(ctx, knowledgeChunks), eq(knowledgeChunks.documentId, documentId)));

  await record(ctx, {
    action: 'knowledge.deleted',
    resourceType: 'knowledge_document',
    resourceId: documentId,
    riskLevel: 'medium',
  });
}

export async function knowledgeStats(ctx: Ctx) {
  const [row] = await ctx.db
    .select({
      documents: sql<number>`count(*)::int`,
      chunks: sql<number>`(
        SELECT count(*)::int FROM knowledge_chunks kc WHERE kc.workspace_id = ${ctx.workspaceId}
      )`,
      indexed: sql<number>`count(*) FILTER (WHERE ${knowledgeDocuments.indexedAt} IS NOT NULL)::int`,
    })
    .from(knowledgeDocuments)
    .where(scope(ctx, knowledgeDocuments));

  return {
    documents: row?.documents ?? 0,
    chunks: row?.chunks ?? 0,
    indexed: row?.indexed ?? 0,
  };
}
