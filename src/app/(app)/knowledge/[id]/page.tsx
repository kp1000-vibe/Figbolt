import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, requireCtx } from '@/server/context';
import { getKnowledgeDocument } from '@/server/knowledge';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
} from '@/components/ui/primitives';
import { KnowledgeActions } from '../actions-client';
import { number, relativeTime, shortDate, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { document } = await getKnowledgeDocument(ctx, id);
    return { title: document.title };
  } catch {
    return { title: 'Knowledge' };
  }
}

export default async function KnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getKnowledgeDocument>>;
  try {
    detail = await getKnowledgeDocument(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { document, chunks } = detail;

  return (
    <PageShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
            <Link href="/knowledge" className="hover:text-text">
              Knowledge
            </Link>
          </nav>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-text text-balance">
              {document.title}
            </h1>
            <Badge tone="outline">{titleCase(document.category)}</Badge>
            {document.trusted && (
              <Badge tone="success" title="Agents may follow guidance from this document.">
                Trusted
              </Badge>
            )}
          </div>
          {document.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {document.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <KnowledgeActions
          existing={{
            id: document.id,
            title: document.title,
            category: document.category,
            content: document.content,
            tags: document.tags,
          }}
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Content</CardTitle>
          </CardHeader>
          <CardBody className="pt-0">
            <article className="prose-sm max-w-none">
              <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap text-text">
                {document.content}
              </pre>
            </article>
          </CardBody>
        </Card>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <dl>
                <DetailRow label="Version">v{document.version}</DetailRow>
                <DetailRow label="Added by">{detail.uploadedByName ?? '—'}</DetailRow>
                <DetailRow label="Created">{shortDate(document.createdAt)}</DetailRow>
                <DetailRow label="Updated">{relativeTime(document.updatedAt)}</DetailRow>
                <DetailRow label="Indexed">
                  {document.indexedAt ? relativeTime(document.indexedAt) : 'not indexed'}
                </DetailRow>
                <DetailRow label="Chunks">{number(chunks.length)}</DetailRow>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Retrievable passages</CardTitle>
                <p className="mt-0.5 text-2xs text-text-subtle">
                  How this document is split for search. Each chunk is what an agent can cite.
                </p>
              </div>
            </CardHeader>
            <CardBody className="pt-0">
              {chunks.length === 0 ? (
                <p className="text-xs text-text-subtle">
                  Not indexed yet. Save the document to build its chunks.
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {chunks.map((chunk) => (
                    <li
                      key={chunk.id}
                      className="flex items-baseline gap-2 rounded-[var(--radius-sm)] bg-bg-subtle px-2.5 py-1.5"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-text-subtle">
                        {String(chunk.chunkIndex).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">
                        {chunk.heading ?? 'Untitled section'}
                      </span>
                      <span className="shrink-0 text-[10px] text-text-subtle">
                        ~{chunk.tokenCount ?? 0} tok
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
