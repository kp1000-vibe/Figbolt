'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { ArrowRight, Sparkle } from '@/components/layout/icons';

/**
 * The inline ask box.
 *
 * Appears on Home and on every record detail page. It does not answer in
 * place — it routes to `/ask`, which owns the answer surface with its
 * citations and evidence panel. One place to render an answer means one place
 * to get grounding and confidence right.
 */
export function AskInline({
  placeholder = 'Ask anything…',
  scopeType,
  scopeId,
  scopeLabel,
  suggestions = [],
  className,
}: {
  placeholder?: string;
  scopeType?: 'account' | 'opportunity' | 'contact';
  scopeId?: string;
  scopeLabel?: string;
  suggestions?: string[];
  className?: string;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const submit = (question: string) => {
    const q = question.trim();
    if (q.length < 2) return;
    setPending(true);

    const params = new URLSearchParams({ q });
    if (scopeType && scopeId) {
      params.set('scopeType', scopeType);
      params.set('scopeId', scopeId);
    }
    router.push(`/ask?${params.toString()}`);
  };

  return (
    <div className={cn('min-w-0', className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        className="group relative"
      >
        <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-accent">
          <Sparkle className="size-4" />
        </span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={scopeLabel ? `Ask about ${scopeLabel}` : 'Ask anything about your customers'}
          className="h-11 w-full rounded-[var(--radius-lg)] border border-border bg-surface pr-24 pl-10 text-sm text-text shadow-[var(--shadow-sm)] transition-[border-color,box-shadow] placeholder:text-text-subtle focus:border-accent focus:ring-3 focus:ring-accent/12 focus:outline-none"
          disabled={pending}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          className="absolute top-1/2 right-2 -translate-y-1/2"
          disabled={pending || value.trim().length < 2}
        >
          {pending ? 'Asking…' : 'Ask'}
          {!pending && <ArrowRight />}
        </Button>
      </form>

      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => submit(suggestion)}
              disabled={pending}
              className="rounded-full border border-border bg-surface px-2.5 py-1 text-2xs text-text-muted transition-colors hover:border-accent-border hover:bg-accent-subtle hover:text-accent-text disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
