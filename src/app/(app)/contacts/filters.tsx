'use client';

import { FilterBar, type FilterSpec } from '@/components/crm/filter-bar';

export function ContactFiltersBar({
  facets,
  current,
}: {
  facets: { owners: { id: string; name: string }[]; roleCounts: { value: string; n: number }[] };
  current: Record<string, string | undefined>;
}) {
  const filters: FilterSpec[] = [
    { kind: 'search', key: 'q', placeholder: 'Search name, email or title…' },
    {
      kind: 'select',
      key: 'seniority',
      label: 'Seniority',
      options: [
        { value: 'c_level', label: 'C-level' },
        { value: 'vp', label: 'VP' },
        { value: 'director', label: 'Director' },
        { value: 'manager', label: 'Manager' },
        { value: 'ic', label: 'Individual contributor' },
      ],
    },
    {
      kind: 'select',
      key: 'owner',
      label: 'Owner',
      options: facets.owners.map((o) => ({ value: o.id, label: o.name })),
    },
    {
      kind: 'chips',
      key: 'role',
      label: 'Buying role',
      options: facets.roleCounts.map((r) => ({
        value: r.value,
        label: r.value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        count: r.n,
      })),
    },
  ];

  return (
    <FilterBar
      filters={filters}
      current={current}
      sortOptions={[
        { value: 'name', label: 'Name' },
        { value: 'influence', label: 'Influence' },
        { value: 'activity', label: 'Last contact' },
        { value: 'account', label: 'Account' },
      ]}
    />
  );
}
