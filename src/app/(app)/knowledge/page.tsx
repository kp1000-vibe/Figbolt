import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { knowledgeStats, listKnowledge } from '@/server/knowledge';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  PageHeader,
  Stat,
} from '@/components/ui/primitives';
import { KnowledgeActions } from './actions-client';
import { NavIcon, Shield } from '@/components/layout/icons';
import { number, relativeTime, titleCase } from '@/lib/utils';

export const metadata = { title: 'Knowledge' };

const CATEGORY_LABEL: Record<string, string> = {
  product: 'Product',
  pricing: 'Pricing',
  security: 'Security',
  playbook: 'Playbook',
  case_study: 'Case study',
  battlecard: 'Battlecard',
  methodology: 'Methodology',
  onboarding: 'Onboarding',
  other: 'Other',
};

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [documents, stats] = await Promise.all([
    listKnowledge(ctx, { category: params.category, query: params.q }),
    knowledgeStats(ctx),
  ]);

  const grouped = documents.reduce<Record<string, typeof documents>>((acc, doc) => {
    const key = doc.category;
    (acc[key] ??= []).push(doc);
    return acc;
  }, {});

  return (
    <PageShell>
      <PageHeader
        title="Knowledge"
        description="What your agents know about your own company: product, pricing, security posture, playbooks and battlecards."
        actions={<KnowledgeActions />}
      />

      <Card className="mt-5">
        <CardBody className="grid grid-cols-3 gap-5 pt-4">
          <Stat label="Documents" value={number(stats.documents)} />
          <Stat label="Indexed chunks" value={number(stats.chunks)} hint="Retrievable passages" />
          <Stat
            label="Searchable"
            value={`${stats.indexed}/${stats.documents}`}
            tone={stats.indexed === stats.documents ? 'success' : 'warning'}
          />
        </CardBody>
      </Card>

      <Card className="mt-5 border-accent-border bg-accent-subtle">
        <CardBody className="flex gap-2.5 pt-3.5">
          <Shield className="mt-0.5 size-4 shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-accent-text">
              Knowledge is trusted; customer content is not
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-accent-text/85 text-pretty">
              Agents may follow guidance from these documents. They may never follow instructions
              found inside a customer email, document or transcript — that content is fenced as
              untrusted data before it reaches a model, and tool permissions are enforced
              independently of anything a model outputs.
            </p>
          </div>
        </CardBody>
      </Card>

      {documents.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="book" />}
          title="No knowledge documents yet"
          description="Add your pricing, security posture, competitive battlecards and qualification framework so agents can cite them when they answer."
        />
      ) : (
        <div className="mt-6 space-y-6">
          {Object.entries(grouped).map(([category, docs]) => (
            <section key={category}>
              <h2 className="mb-2.5 text-2xs font-semibold tracking-wide text-text-subtle uppercase">
                {CATEGORY_LABEL[category] ?? titleCase(category)} · {docs.length}
              </h2>
              <ul className="space-y-2">
                {docs.map((doc) => (
                  <Card as="li" key={doc.id}>
                    <CardBody className="pt-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            href={`/knowledge/${doc.id}`}
                            className="text-sm font-medium text-text hover:text-accent-text"
                          >
                            {doc.title}
                          </Link>
                          {doc.summary && (
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-muted text-pretty">
                              {doc.summary}
                            </p>
                          )}
                          {doc.tags.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {doc.tags.map((tag) => (
                                <Badge key={tag} tone="outline">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="shrink-0 text-right text-2xs text-text-subtle">
                          <p>{number(doc.wordCount ?? 0)} words</p>
                          <p>{doc.chunkCount} chunks</p>
                          <p className="mt-0.5">v{doc.version}</p>
                        </div>
                      </div>

                      <p className="mt-2 text-2xs text-text-subtle">
                        {doc.indexedAt ? `Indexed ${relativeTime(doc.indexedAt)}` : 'Not indexed'}
                        {doc.uploadedByName && ` · added by ${doc.uploadedByName}`}
                      </p>
                    </CardBody>
                  </Card>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
