'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Button, Input, Select } from '@/components/ui/primitives';
import { Close, Filter, Search } from '@/components/layout/icons';

/**
 * URL-driven filter bar.
 *
 * Filters live in the query string rather than component state, so a filtered
 * view is shareable, survives a reload, and works with the back button. That
 * also keeps the list itself a server component — filtering is a navigation,
 * not a client-side re-render.
 */

export type FilterOption = { value: string; label: string; count?: number };

export type FilterSpec =
  | { kind: 'search'; key: string; placeholder: string }
  | { kind: 'select'; key: string; label: string; options: FilterOption[] }
  | { kind: 'chips'; key: string; label: string; options: FilterOption[] };

export function FilterBar({
  filters,
  current,
  sortOptions,
}: {
  filters: FilterSpec[];
  current: Record<string, string | undefined>;
  sortOptions?: FilterOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = React.useState(current['q'] ?? '');
  const [pending, setPending] = React.useState(false);

  const searchSpec = filters.find((f) => f.kind === 'search');

  const apply = React.useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      setPending(true);
      router.push(`${pathname}?${next.toString()}`);
      // The server component re-renders on navigation; clear the local
      // pending flag once React has committed the new tree.
      setTimeout(() => setPending(false), 400);
    },
    [pathname, router, searchParams],
  );

  // Debounce typing so a search doesn't push a history entry per keystroke.
  React.useEffect(() => {
    if (!searchSpec) return;
    const currentQ = current['q'] ?? '';
    if (searchValue === currentQ) return;

    const timer = setTimeout(() => apply({ [searchSpec.key]: searchValue || null }), 350);
    return () => clearTimeout(timer);
  }, [searchValue, searchSpec, current, apply]);

  const activeCount = filters.filter(
    (f) => f.kind !== 'search' && current[f.key] && current[f.key] !== '',
  ).length;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {searchSpec && (
          <div className="relative min-w-56 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-text-subtle" />
            <Input
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={searchSpec.placeholder}
              className="h-8 pl-8.5 text-xs"
              aria-label={searchSpec.placeholder}
            />
            {searchValue && (
              <button
                type="button"
                onClick={() => setSearchValue('')}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-text-subtle hover:text-text"
                aria-label="Clear search"
              >
                <Close className="size-3" />
              </button>
            )}
          </div>
        )}

        {filters
          .filter((f): f is Extract<FilterSpec, { kind: 'select' }> => f.kind === 'select')
          .map((filter) => (
            <Select
              key={filter.key}
              value={current[filter.key] ?? ''}
              onChange={(e) => apply({ [filter.key]: e.target.value || null })}
              className="h-8 w-auto min-w-32 text-xs"
              aria-label={filter.label}
            >
              <option value="">{filter.label}: any</option>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                  {option.count != null ? ` (${option.count})` : ''}
                </option>
              ))}
            </Select>
          ))}

        {sortOptions && sortOptions.length > 0 && (
          <Select
            value={current['sort'] ?? ''}
            onChange={(e) => apply({ sort: e.target.value || null })}
            className="h-8 w-auto min-w-32 text-xs"
            aria-label="Sort by"
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                Sort: {option.label}
              </option>
            ))}
          </Select>
        )}

        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const cleared: Record<string, string | null> = {};
              for (const f of filters) cleared[f.key] = null;
              cleared['sort'] = null;
              cleared['dir'] = null;
              setSearchValue('');
              apply(cleared);
            }}
          >
            <Close />
            Clear {activeCount}
          </Button>
        )}

        {pending && <span className="text-2xs text-text-subtle">Updating…</span>}
      </div>

      {filters
        .filter((f): f is Extract<FilterSpec, { kind: 'chips' }> => f.kind === 'chips')
        .map((filter) => (
          <div key={filter.key} className="flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 text-2xs text-text-subtle">
              <Filter className="size-3" />
              {filter.label}
            </span>
            {filter.options.map((option) => {
              const active = current[filter.key] === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => apply({ [filter.key]: active ? null : option.value })}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-2xs transition-colors',
                    active
                      ? 'border-accent-border bg-accent-subtle font-medium text-accent-text'
                      : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
                  )}
                >
                  {option.label}
                  {option.count != null && (
                    <span className="ml-1 text-text-subtle">{option.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}
