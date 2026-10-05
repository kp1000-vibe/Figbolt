import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { ask, listConversations } from '@/server/ai/ask';
import { listReports } from '@/server/analytics/ask';
import { PageShell } from '@/components/layout/app-shell';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  SectionLabel,
} from '@/components/ui/primitives';
import { AnswerCard } from '@/components/ai/answer';
import { AskInline } from '@/components/ai/ask-inline';
import { AnalyticsResultView } from '@/components/ai/analytics-view';
import { EvidencePanel } from '@/components/ai/evidence-panel';
import { AskActions } from './ask-actions';
import { Sparkle } from '@/components/layout/icons';
import { relativeTime } from '@/lib/utils';

export const metadata = { title: 'Ask AI' };

/**
 * Ask AI.
 *
 * The question is a URL parameter rather than client state, so an answer is
 * shareable and survives a reload — and the whole page is a server component,
 * which means retrieval and reasoning happen before first paint instead of
 * behind a spinner.
 */
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; scopeType?: string; scopeId?: string; conversationId?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();
  const question = params.q?.trim();

  const [conversations, reports] = await Promise.all([listConversations(ctx, 12), listReports()]);

  const result = question
    ? await ask(ctx, {
        question,
        conversationId: params.conversationId,
        scopeType:
          params.scopeType === 'account' || params.scopeType === 'opportunity' || params.scopeType === 'contact'
            ? params.scopeType
            : undefined,
        scopeId: params.scopeId,
      }).catch((err: Error) => ({ error: err.message }) as const)
    : null;

  return (
    <PageShell wide>
      <PageHeader
        title="Ask Bolt"
        description="Answers come from this workspace's own records — emails, meeting transcripts, notes and CRM fields — with a citation for every claim."
        eyebrow={
          <Badge tone="accent">
            <Sparkle className="size-3" />
            Grounded in your CRM
          </Badge>
        }
      />

      <div className="mt-5">
        <AskInline
          placeholder="Ask anything about your customers or tell Bolt what to do…"
          scopeType={
            params.scopeType === 'account' || params.scopeType === 'opportunity' || params.scopeType === 'contact'
              ? params.scopeType
              : undefined
          }
          scopeId={params.scopeId}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {!question && <Suggestions reports={reports} />}

          {question && result && 'error' in result && (
            <Card className="border-danger/30 bg-danger-subtle">
              <CardBody className="pt-4">
                <p className="text-sm font-medium text-danger-text">That question could not be answered</p>
                <p className="mt-1 text-xs text-danger-text/85 text-pretty">{result.error}</p>
              </CardBody>
            </Card>
          )}

          {question && result && !('error' in result) && (
            <>
              <div>
                <SectionLabel>Your question</SectionLabel>
                <p className="mt-1.5 text-base font-medium text-text text-balance">{question}</p>
                {/* Who made the calls: Jev decides, an LLM writes — and some
                    questions never need an LLM at all. */}
                <p className="mt-1.5 text-2xs text-text-subtle">
                  {result.decisions.intentBy === 'jev' ? 'Understood by Jev' : 'Understood by an LLM'}
                  {' · '}
                  {result.decisions.llmUsed
                    ? 'answered by an LLM'
                    : result.model === 'report'
                      ? 'answered from a report — no LLM needed'
                      : 'no LLM needed'}
                </p>
              </div>

              {result.analytics ? (
                <AnalyticsResultView result={result.analytics} />
              ) : (
                <AnswerCard
                  envelope={{
                    answer: result.answer,
                    confidence: result.confidence,
                    sources: result.sources,
                    recommendedActions: result.recommendedActions,
                    extractedEntities: result.extractedEntities,
                    reasoningSummary: result.reasoningSummary,
                    caveat: result.caveat,
                  }}
                  footer={
                    <span
                      className="ml-auto shrink-0 font-mono text-2xs text-text-subtle"
                      title={
                        result.routing?.failedOverFrom
                          ? `Jev chose ${result.routing.failedOverFrom}; it failed, so the default answered.`
                          : result.routing?.decidedBy === 'jev'
                            ? `Jev chose this model (confidence ${Math.round((result.routing.confidence ?? 0) * 100)}%).`
                            : result.routing
                              ? `Default model — Jev did not decide (${result.routing.reason.replace(/_/g, ' ')}).`
                              : undefined
                      }
                    >
                      {result.model}
                      {result.routing?.decidedBy === 'jev' && !result.routing.failedOverFrom && ' · chosen by Jev'}
                      {result.routing?.failedOverFrom && ' · failover'}
                      {' · '}
                      {result.latencyMs}ms
                    </span>
                  }
                />
              )}

              {result.recommendedActions.length > 0 && (
                <AskActions
                  actions={result.recommendedActions}
                  entities={result.extractedEntities}
                />
              )}

              {result.extractedEntities.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Records in this answer</CardTitle>
                  </CardHeader>
                  <CardBody className="pt-0">
                    <div className="flex flex-wrap gap-1.5">
                      {result.extractedEntities.map((entity, i) => (
                        <Link
                          key={i}
                          href={
                            entity.type === 'account'
                              ? `/accounts/${entity.id}`
                              : entity.type === 'opportunity'
                                ? `/opportunities/${entity.id}`
                                : `/contacts/${entity.id}`
                          }
                          className="rounded-full border border-border bg-surface px-2.5 py-1 text-2xs text-text-muted transition-colors hover:border-accent-border hover:text-accent-text"
                        >
                          {entity.label}
                          <span className="ml-1.5 text-text-subtle">{entity.type}</span>
                        </Link>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              )}
            </>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          {question && result && !('error' in result) && result.evidence.length > 0 && (
            <EvidencePanel evidence={result.evidence} />
          )}

          <Card>
            <CardHeader>
              <CardTitle>Recent questions</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {conversations.length === 0 ? (
                <p className="text-xs text-text-subtle">Nothing asked yet.</p>
              ) : (
                <ul className="space-y-2">
                  {conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        href={`/ask?q=${encodeURIComponent(conversation.title)}`}
                        className="group block min-w-0"
                      >
                        <p className="truncate text-xs text-text group-hover:text-accent-text">
                          {conversation.title}
                        </p>
                        <p className="text-2xs text-text-subtle">
                          {relativeTime(conversation.updatedAt)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card className="border-accent-border bg-accent-subtle">
            <CardBody className="pt-4">
              <p className="text-xs font-semibold text-accent-text">How grounding works</p>
              <ul className="mt-2 space-y-1.5 text-2xs leading-relaxed text-accent-text/85">
                <li>
                  Your question is classified, entities are resolved to real records, then structured
                  and semantic retrieval run together and are fused by rank.
                </li>
                <li>
                  Retrieved customer content is treated as untrusted data. Instructions inside an
                  email can never become instructions to Bolt.
                </li>
                <li>
                  Citations are validated against what was actually retrieved — a model cannot cite a
                  record it never saw.
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}

const QUESTION_GROUPS: { label: string; questions: string[] }[] = [
  {
    label: 'Understand an account',
    questions: [
      "What's happening with Acme?",
      'What is blocking the Acme deal?',
      'What did we commit to Halcyon Health?',
      'Which customers seem unhappy?',
    ],
  },
  {
    label: 'Work the pipeline',
    questions: [
      'Which deals are most likely to close this month?',
      'Show opportunities with no activity for 14 days',
      'Which deals have no identified champion?',
      'What should I do next on Continental Freight?',
    ],
  },
  {
    label: 'Find patterns',
    questions: [
      'What objections keep coming up in enterprise deals?',
      'Which customers mentioned SOC 2?',
      'Which requested features represent the most pipeline?',
      'Do security reviews slow deals down?',
    ],
  },
];

function Suggestions({ reports }: { reports: { id: string; label: string; example: string }[] }) {
  return (
    <>
      <EmptyState
        icon={<Sparkle />}
        title="Ask a question to get started"
        description="Bolt searches structured CRM fields, email bodies, meeting transcripts and your knowledge base, then answers with links back to the records it used."
      />

      <div className="space-y-5">
        {QUESTION_GROUPS.map((group) => (
          <div key={group.label}>
            <SectionLabel>{group.label}</SectionLabel>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {group.questions.map((q) => (
                <Link
                  key={q}
                  href={`/ask?q=${encodeURIComponent(q)}`}
                  className="group flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-xs text-text-muted shadow-[var(--shadow-sm)] transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent-text"
                >
                  <Sparkle className="size-3.5 shrink-0 text-text-subtle group-hover:text-accent" />
                  <span className="min-w-0 flex-1">{q}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}

        <div>
          <SectionLabel>Analytics questions</SectionLabel>
          <p className="mt-1 text-2xs text-text-subtle text-pretty">
            These route to pre-approved, read-only report templates rather than model-written SQL.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {reports.map((report) => (
              <Link
                key={report.id}
                href={`/ask?q=${encodeURIComponent(report.example)}`}
                className="group flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-xs text-text-muted shadow-[var(--shadow-sm)] transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent-text"
              >
                <span className="min-w-0 flex-1">{report.example}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
