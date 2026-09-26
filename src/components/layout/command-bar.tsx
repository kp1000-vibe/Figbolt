'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Badge, Kbd, Spinner } from '@/components/ui/feedback';
import { NAV_FLAT } from './nav';
import { NavIcon, ArrowRight, Close, Search, Sparkle } from './icons';

/**
 * The AI command bar.
 *
 * One input, three jobs: ask a question, jump to a record, or run a command.
 * The mode is inferred from what is typed rather than chosen from a toggle —
 * anything phrased as a question or an instruction goes to the AI, and short
 * fragments are treated as navigation. Getting that inference right is what
 * makes a single box viable as the product's front door.
 */

export type SearchHit = {
  type: 'account' | 'contact' | 'opportunity' | 'meeting' | 'email' | 'task' | 'knowledge';
  id: string;
  label: string;
  sublabel?: string;
  href: string;
};

const SUGGESTIONS = [
  "What's happening with Acme?",
  'Which deals are most likely to close this month?',
  'Which customers mentioned SOC 2?',
  'Show opportunities with no activity for 14 days',
  'What objections keep coming up in enterprise deals?',
  'Which requested features represent the most pipeline?',
  'Why did our last enterprise deals fail?',
  'Which customers seem unhappy?',
];

/** Phrasings that mean "answer me" rather than "take me there". */
const QUESTION_SHAPE =
  /^(what|who|which|why|how|when|where|show|find|list|draft|create|move|update|summar|tell|give|does|do|is|are|can|should)\b|\?\s*$/i;

export function CommandBar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [cursor, setCursor] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const trimmed = query.trim();
  const looksLikeQuestion = trimmed.length > 12 && QUESTION_SHAPE.test(trimmed);

  const navMatches = React.useMemo(() => {
    if (!trimmed) return [];
    const q = trimmed.toLowerCase();
    return NAV_FLAT.filter((item) => item.label.toLowerCase().includes(q)).slice(0, 4);
  }, [trimmed]);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setHits([]);
      setCursor(0);
      // Defer so the element exists before focusing.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /* Debounced record search. Aborts in-flight requests so a fast typist never
     sees results for a prefix they've already moved past. */
  React.useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (res.ok) setHits(((await res.json()) as { hits: SearchHit[] }).hits);
      } catch {
        /* aborted or offline — leave the previous hits in place */
      } finally {
        setSearching(false);
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const rows = React.useMemo(() => {
    const out: { kind: 'ask' | 'nav' | 'hit' | 'suggestion'; key: string; payload?: unknown }[] = [];
    if (trimmed.length > 2) out.push({ kind: 'ask', key: 'ask' });
    for (const item of navMatches) out.push({ kind: 'nav', key: `nav:${item.href}`, payload: item });
    for (const hit of hits) out.push({ kind: 'hit', key: `hit:${hit.type}:${hit.id}`, payload: hit });
    if (!trimmed) {
      for (const s of SUGGESTIONS) out.push({ kind: 'suggestion', key: `sug:${s}`, payload: s });
    }
    return out;
  }, [trimmed, navMatches, hits]);

  const go = React.useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;

      if (row.kind === 'ask') {
        router.push(`/ask?q=${encodeURIComponent(trimmed)}`);
      } else if (row.kind === 'nav') {
        router.push((row.payload as { href: string }).href);
      } else if (row.kind === 'hit') {
        router.push((row.payload as SearchHit).href);
      } else if (row.kind === 'suggestion') {
        router.push(`/ask?q=${encodeURIComponent(row.payload as string)}`);
      }
      onClose();
    },
    [rows, router, trimmed, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on an unmatched question still asks — never a dead end.
      if (rows.length === 0 && trimmed.length > 2) {
        router.push(`/ask?q=${encodeURIComponent(trimmed)}`);
        onClose();
        return;
      }
      go(cursor);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  React.useEffect(() => setCursor(0), [rows.length]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command bar"
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="animate-scale-in relative w-full max-w-2xl overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface-raised shadow-[var(--shadow-xl)]">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <span className={cn('shrink-0', looksLikeQuestion ? 'text-accent' : 'text-text-subtle')}>
            {looksLikeQuestion ? <Sparkle className="size-4" /> : <Search className="size-4" />}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything about your customers or tell Figbolt what to do…"
            className="h-13 flex-1 bg-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none"
            aria-label="Ask anything about your customers or tell Figbolt what to do"
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <Spinner className="size-3.5 text-text-subtle" />}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-text-subtle hover:text-text"
            aria-label="Close"
          >
            <Close className="size-4" />
          </button>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {!trimmed && (
            <p className="px-2.5 pt-2 pb-1 text-2xs font-semibold tracking-wide text-text-subtle uppercase">
              Try asking
            </p>
          )}

          {rows.map((row, index) => {
            const selected = index === cursor;

            if (row.kind === 'ask') {
              return (
                <Row
                  key={row.key}
                  selected={selected}
                  onSelect={() => go(index)}
                  onHover={() => setCursor(index)}
                  icon={<Sparkle className="size-4 text-accent" />}
                  title={`Ask Figbolt: “${trimmed}”`}
                  subtitle="Searches your CRM, emails and meetings, then answers with citations"
                  trailing={<Kbd>↵</Kbd>}
                />
              );
            }

            if (row.kind === 'nav') {
              const item = row.payload as (typeof NAV_FLAT)[number];
              return (
                <Row
                  key={row.key}
                  selected={selected}
                  onSelect={() => go(index)}
                  onHover={() => setCursor(index)}
                  icon={<NavIcon name={item.icon} className="size-4 text-text-subtle" />}
                  title={item.label}
                  subtitle="Go to page"
                  trailing={<ArrowRight className="size-3.5 text-text-subtle" />}
                />
              );
            }

            if (row.kind === 'hit') {
              const hit = row.payload as SearchHit;
              return (
                <Row
                  key={row.key}
                  selected={selected}
                  onSelect={() => go(index)}
                  onHover={() => setCursor(index)}
                  icon={<NavIcon name={ICON_FOR_TYPE[hit.type]} className="size-4 text-text-subtle" />}
                  title={hit.label}
                  subtitle={hit.sublabel}
                  trailing={<Badge tone="neutral">{TYPE_LABEL[hit.type]}</Badge>}
                />
              );
            }

            return (
              <Row
                key={row.key}
                selected={selected}
                onSelect={() => go(index)}
                onHover={() => setCursor(index)}
                icon={<Sparkle className="size-4 text-text-subtle" />}
                title={row.payload as string}
              />
            );
          })}

          {trimmed.length >= 2 && rows.length <= 1 && !searching && (
            <p className="px-3 py-6 text-center text-xs text-text-subtle">
              No records matched. Press <Kbd>↵</Kbd> to ask Figbolt instead.
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border bg-bg-subtle px-4 py-2 text-2xs text-text-subtle">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> select
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

const ICON_FOR_TYPE = {
  account: 'building',
  contact: 'users',
  opportunity: 'target',
  meeting: 'calendar',
  email: 'inbox',
  task: 'check',
  knowledge: 'book',
} as const;

const TYPE_LABEL = {
  account: 'Account',
  contact: 'Contact',
  opportunity: 'Deal',
  meeting: 'Meeting',
  email: 'Email',
  task: 'Task',
  knowledge: 'Doc',
} as const;

function Row({
  selected,
  onSelect,
  onHover,
  icon,
  title,
  subtitle,
  trailing,
}: {
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);

  // Keep the keyboard cursor in view when arrowing past the fold.
  React.useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        'flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent-subtle' : 'hover:bg-surface-hover',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm', selected ? 'text-accent-text' : 'text-text')}>
          {title}
        </span>
        {subtitle && <span className="block truncate text-2xs text-text-subtle">{subtitle}</span>}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
}
