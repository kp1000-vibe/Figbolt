'use client';

import { FilterBar, type FilterSpec } from '@/components/crm/filter-bar';

export function MeetingFilters({
  current,
  counts,
}: {
  current: Record<string, string | undefined>;
  counts: { total: number; upcoming: number; past: number; unprocessed: number };
}) {
  const filters: FilterSpec[] = [
    { kind: 'search', key: 'q', placeholder: 'Search meeting title…' },
    {
      kind: 'chips',
      key: 'bucket',
      label: 'Show',
      options: [
        { value: 'past', label: 'Past', count: counts.past },
        { value: 'upcoming', label: 'Upcoming', count: counts.upcoming },
        { value: 'unprocessed', label: 'Awaiting processing', count: counts.unprocessed },
      ],
    },
  ];

  return <FilterBar filters={filters} current={current} />;
}
