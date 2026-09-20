'use client';

import { FilterBar, type FilterSpec } from '@/components/crm/filter-bar';

export function SignalFilters({
  current,
  categories,
}: {
  current: Record<string, string | undefined>;
  categories: { value: string; label: string; count: number }[];
}) {
  const filters: FilterSpec[] = [
    { kind: 'chips', key: 'category', label: 'Category', options: categories },
  ];
  return <FilterBar filters={filters} current={current} />;
}
