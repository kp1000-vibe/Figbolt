import Link from 'next/link';
import type { SourceRef } from '@/db/schema';
import { Badge } from '@/components/ui/primitives';
import { cn, dayMonth } from '@/lib/utils';
import { NavIcon, Quote } from '@/components/layout/icons';

/**
 * Source citations.
 *
 * Citations are the product's contract with the user: any AI claim can be
 * walked back to the record that produced it. So a citation is always a real
 * link to a real record — never a label. If a ref cannot be resolved to a
 * destination it renders as inert text rather than a broken link, which is
 * honest about the gap instead of hiding it.
 */

const TYPE_META: Record<
  SourceRef['type'],
  { label: string; href: (id: string) => string | null; icon: 'inbox' | 'calendar' | 'book' | 'building' | 'users' | 'target' | 'check' }
> = {
  email: { label: 'Email', href: (id) => `/inbox/email/${id}`, icon: 'inbox' },
  meeting: { label: 'Meeting', href: (id) => `/meetings/${id}`, icon: 'calendar' },
  transcript: { label: 'Transcript', href: (id) => `/meetings/transcript/${id}`, icon: 'calendar' },
  note: { label: 'Note', href: () => null, icon: 'book' },
  call: { label: 'Call', href: () => null, icon: 'inbox' },
  task: { label: 'Task', href: () => `/tasks`, icon: 'check' },
  commitment: { label: 'Commitment', href: () => `/tasks?tab=commitments`, icon: 'check' },
  crm_event: { label: 'Event', href: () => null, icon: 'book' },
  memory_fact: { label: 'Fact', href: () => null, icon: 'book' },
  knowledge: { label: 'Knowledge', href: (id) => `/knowledge/${id}`, icon: 'book' },
  opportunity: { label: 'Deal', href: (id) => `/opportunities/${id}`, icon: 'target' },
  account: { label: 'Account', href: (id) => `/accounts/${id}`, icon: 'building' },
  contact: { label: 'Contact', href: (id) => `/contacts/${id}`, icon: 'users' },
};

export function CitationChip({
  source,
  index,
  className,
}: {
  source: SourceRef;
  index?: number;
  className?: string;
}) {
  const meta = TYPE_META[source.type] ?? TYPE_META.crm_event;
  const href = meta.href(source.id);

  const inner = (
    <>
      {index != null && (
        <span className="font-mono text-[10px] font-semibold opacity-70">E{index}</span>
      )}
      <NavIcon name={meta.icon} className="size-3 shrink-0 opacity-70" />
      <span className="max-w-[22ch] truncate">{source.label}</span>
      {source.occurredAt && (
        <span className="shrink-0 tabular opacity-60">{dayMonth(source.occurredAt)}</span>
      )}
    </>
  );

  const base = cn(
    'inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs transition-colors',
    className,
  );

  if (!href) {
    return (
      <span
        className={cn(base, 'border-border bg-bg-muted text-text-muted')}
        title={source.snippet ?? source.label}
      >
        {inner}
      </span>
    );
  }

  return (
    <Link
      href={href}
      className={cn(
        base,
        'border-accent-border bg-accent-subtle text-accent-text hover:border-accent hover:bg-accent-subtle/70',
      )}
      title={source.snippet ?? source.label}
    >
      {inner}
    </Link>
  );
}

export function CitationList({
  sources,
  numbered = true,
  label = 'Sources',
  className,
}: {
  sources: SourceRef[];
  numbered?: boolean;
  label?: string;
  className?: string;
}) {
  if (sources.length === 0) return null;

  return (
    <div className={cn('min-w-0', className)}>
      <p className="mb-1.5 text-2xs font-semibold tracking-wide text-text-subtle uppercase">
        {label} · {sources.length}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((source, i) => (
          <CitationChip
            key={`${source.type}:${source.id}:${i}`}
            source={source}
            index={numbered ? i + 1 : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A verbatim quote with attribution — used wherever a derived fact needs to
 * show the sentence it came from (commitments, objections, product signals).
 */
export function EvidenceQuote({
  quote,
  source,
  className,
}: {
  quote: string | null | undefined;
  source?: SourceRef;
  className?: string;
}) {
  if (!quote) return null;

  return (
    <figure
      className={cn(
        'rounded-[var(--radius-md)] border-l-2 border-border-strong bg-bg-subtle py-2 pr-3 pl-3',
        className,
      )}
    >
      <blockquote className="flex gap-2">
        <Quote className="mt-0.5 size-3 shrink-0 text-text-subtle" />
        <p className="text-xs leading-relaxed text-text-muted italic text-pretty">{quote}</p>
      </blockquote>
      {source && (
        <figcaption className="mt-1.5 pl-5">
          <CitationChip source={source} />
        </figcaption>
      )}
    </figure>
  );
}

/**
 * Confidence, shown as a word plus a value. A bare 0.62 means nothing to a
 * reader; "Moderate · 62%" sets an expectation.
 */
export function ConfidenceBadge({ value, className }: { value: number; className?: string }) {
  const pct = Math.round((value > 1 ? value / 100 : value) * 100);
  const { label, tone } =
    pct >= 80
      ? { label: 'High confidence', tone: 'success' as const }
      : pct >= 55
        ? { label: 'Moderate confidence', tone: 'info' as const }
        : pct >= 35
          ? { label: 'Low confidence', tone: 'warning' as const }
          : { label: 'Very low confidence', tone: 'danger' as const };

  return (
    <Badge tone={tone} className={className} title={`Model-reported confidence: ${pct}%`}>
      {label} · {pct}%
    </Badge>
  );
}
