import type { SourceRef } from '@/db/schema';
import type { AnswerEnvelope } from '@/lib/ai/types';
import { Badge, Card, SectionLabel } from '@/components/ui/primitives';
import { AlertTriangle, Sparkle } from '@/components/layout/icons';
import { cn } from '@/lib/utils';
import { CitationChip, CitationList, ConfidenceBadge } from './citation';

/**
 * Rendering an AI answer.
 *
 * The layout enforces the product's four questions in order: what happened
 * (the answer), what supports it (inline citations + source list), how sure it
 * is (confidence and caveat), and what to do (recommended actions). Nothing is
 * optional-by-omission — a missing caveat means the model didn't flag one, and
 * an empty source list is rendered as an explicit warning rather than hidden.
 */

export function AnswerCard({
  envelope,
  compact = false,
  className,
  footer,
}: {
  envelope: AnswerEnvelope;
  compact?: boolean;
  className?: string;
  footer?: React.ReactNode;
}) {
  const ungrounded = envelope.sources.length === 0;

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
          <Sparkle className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <AnswerBody text={envelope.answer} sources={envelope.sources} />

          {envelope.caveat && (
            <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-warning/30 bg-warning-subtle px-2.5 py-2 text-xs text-warning-text text-pretty">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {envelope.caveat}
            </p>
          )}

          {ungrounded && (
            <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger/25 bg-danger-subtle px-2.5 py-2 text-xs text-danger-text text-pretty">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              No source records back this answer. Treat it as unverified.
            </p>
          )}
        </div>
      </div>

      {!compact && envelope.recommendedActions.length > 0 && (
        <div className="mt-4 px-4">
          <SectionLabel>Recommended next</SectionLabel>
          <ul className="mt-2 space-y-2">
            {envelope.recommendedActions.map((action, i) => (
              <li
                key={i}
                className="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2"
              >
                <p className="text-xs font-medium text-text">{action.title}</p>
                <p className="mt-0.5 text-2xs text-text-muted text-pretty">{action.why}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {envelope.sources.length > 0 && (
        <div className="mt-4 border-t border-border bg-bg-subtle px-4 py-3">
          <CitationList sources={envelope.sources} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <ConfidenceBadge value={envelope.confidence} />
        {envelope.reasoningSummary && (
          <p className="min-w-0 flex-1 truncate text-2xs text-text-subtle" title={envelope.reasoningSummary}>
            {envelope.reasoningSummary}
          </p>
        )}
        {footer}
      </div>
    </Card>
  );
}

/**
 * Render the answer, turning `[E1]` markers into real citation chips.
 *
 * Markdown is deliberately handled by hand and limited to bold, bullets and
 * headings: rendering arbitrary model output through a full markdown pipeline
 * would mean trusting it with HTML, and this text is derived from untrusted
 * customer conversations.
 */
function AnswerBody({ text, sources }: { text: string; sources: SourceRef[] }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());

  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const isList = lines.every((l) => /^\s*[-•*]\s+/.test(l));

        if (isList) {
          return (
            <ul key={i} className="space-y-1.5">
              {lines.map((line, j) => (
                <li key={j} className="flex gap-2 text-sm leading-relaxed text-text text-pretty">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-text-subtle" />
                  <span>{renderInline(line.replace(/^\s*[-•*]\s+/, ''), sources)}</span>
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={i} className="text-sm leading-relaxed text-text text-pretty">
            {lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {renderInline(line, sources)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** Inline pass: `**bold**` and `[E1]` citation markers. */
function renderInline(text: string, sources: SourceRef[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*)|(\[E(\d+)\])/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));

    if (match[1]) {
      out.push(
        <strong key={key++} className="font-semibold text-text">
          {match[1].slice(2, -2)}
        </strong>,
      );
    } else if (match[3]) {
      const index = Number(match[3]);
      const source = sources[index - 1];
      out.push(
        source ? (
          <CitationChip key={key++} source={source} index={index} className="mx-0.5 align-middle" />
        ) : (
          // The model cited an index we don't have — say so rather than
          // rendering a chip that goes nowhere.
          <Badge key={key++} tone="neutral" className="mx-0.5 align-middle" title="Unresolved citation">
            E{index}?
          </Badge>
        ),
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

/* ── Insight card ─────────────────────────────────────────────────────────── */

export function InsightCard({
  insight,
  className,
}: {
  insight: {
    id: string;
    kind: string;
    title: string;
    body: string;
    metrics: Record<string, number | string> | null;
    evidence: SourceRef[];
    confidence: number;
    severity: 'info' | 'warning' | 'critical';
  };
  className?: string;
}) {
  const tone = insight.severity === 'critical' ? 'danger' : insight.severity === 'warning' ? 'warning' : 'info';

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="px-4 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-text text-balance">
            {insight.title}
          </h3>
          <Badge tone={tone}>{insight.kind}</Badge>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-text-muted text-pretty">{insight.body}</p>

        {insight.metrics && Object.keys(insight.metrics).length > 0 && (
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {Object.entries(insight.metrics)
              .slice(0, 5)
              .map(([key, value]) => (
                <div key={key}>
                  <dt className="text-[10px] tracking-wide text-text-subtle uppercase">
                    {key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                  </dt>
                  <dd className="text-xs font-semibold tabular text-text">
                    {typeof value === 'number' ? value.toLocaleString() : value}
                  </dd>
                </div>
              ))}
          </dl>
        )}
      </div>

      {insight.evidence.length > 0 && (
        <div className="mt-3.5 border-t border-border bg-bg-subtle px-4 py-3">
          <CitationList sources={insight.evidence} numbered={false} label="Evidence" />
        </div>
      )}
    </Card>
  );
}
