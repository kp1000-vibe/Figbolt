'use client';

import * as React from 'react';
import type { TranscriptSegment } from '@/db/schema';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from '@/components/ui/primitives';
import { Close, Search } from '@/components/layout/icons';
import { cn } from '@/lib/utils';

/**
 * Transcript reader.
 *
 * The transcript is the ground truth every extracted commitment, objection and
 * signal points back to, so it has to be readable and searchable — and lines
 * that produced a commitment are marked, which is what closes the loop from a
 * task card back to the sentence someone actually said.
 */
export function TranscriptView({
  transcript,
  commitmentSegments,
}: {
  transcript: { id: string; segments: TranscriptSegment[]; durationSeconds: number | null };
  commitmentSegments: number[];
}) {
  const [query, setQuery] = React.useState('');
  const [customerOnly, setCustomerOnly] = React.useState(false);
  const marked = React.useMemo(() => new Set(commitmentSegments), [commitmentSegments]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return transcript.segments.filter((segment) => {
      if (customerOnly && !segment.isCustomer) return false;
      if (!q) return true;
      return segment.text.toLowerCase().includes(q) || segment.speaker.toLowerCase().includes(q);
    });
  }, [transcript.segments, query, customerOnly]);

  return (
    <Card id={`transcript-${transcript.id}`}>
      <CardHeader>
        <div>
          <CardTitle>Transcript</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">
            {transcript.segments.length} lines
            {transcript.durationSeconds
              ? ` · ${Math.round(transcript.durationSeconds / 60)} min`
              : ''}{' '}
            · verbatim and never modified
          </p>
        </div>
      </CardHeader>

      <CardBody className="pt-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-text-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the transcript…"
              className="h-8 pl-8.5 text-xs"
              aria-label="Search the transcript"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-text-subtle hover:text-text"
                aria-label="Clear search"
              >
                <Close className="size-3" />
              </button>
            )}
          </div>

          <Button
            variant={customerOnly ? 'subtle' : 'ghost'}
            size="sm"
            aria-pressed={customerOnly}
            onClick={() => setCustomerOnly((v) => !v)}
          >
            Customer only
          </Button>

          <span className="text-2xs text-text-subtle">
            {filtered.length} of {transcript.segments.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-border px-4 py-8 text-center text-xs text-text-subtle">
            No lines match.
          </p>
        ) : (
          <ol className="max-h-[36rem] space-y-2.5 overflow-y-auto pr-1">
            {filtered.map((segment) => (
              <li
                key={segment.index}
                id={`segment-${segment.index}`}
                className={cn(
                  'scroll-mt-4 rounded-[var(--radius-md)] px-2.5 py-2 transition-colors',
                  marked.has(segment.index)
                    ? 'border border-accent-border bg-accent-subtle/50'
                    : segment.isCustomer
                      ? 'bg-bg-subtle'
                      : '',
                )}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={cn(
                      'text-2xs font-semibold',
                      segment.isCustomer ? 'text-info-text' : 'text-text-muted',
                    )}
                  >
                    {segment.speaker}
                  </span>
                  <span className="font-mono text-[10px] text-text-subtle">
                    {formatTimestamp(segment.startSeconds)}
                  </span>
                  {segment.isCustomer && <Badge tone="info">Customer</Badge>}
                  {marked.has(segment.index) && (
                    <Badge tone="accent" title="A commitment was extracted from this line">
                      Commitment
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text text-pretty">
                  {highlight(segment.text, query)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;

  // Escape the query so a user typing regex metacharacters cannot break this.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="rounded-[2px] bg-warning-subtle px-0.5 text-warning-text">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
