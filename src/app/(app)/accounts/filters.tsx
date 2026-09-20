'use client';

import { FilterBar, type FilterSpec } from '@/components/crm/filter-bar';

export function AccountFiltersBar({
  facets,
  current,
}: {
  facets: { industries: { value: string; n: number }[]; owners: { id: string; name: string }[] };
  current: Record<string, string | undefined>;
}) {
  const filters: FilterSpec[] = [
    { kind: 'search', key: 'q', placeholder: 'Search company or domain…' },
    {
      kind: 'select',
      key: 'industry',
      label: 'Industry',
      options: facets.industries.map((i) => ({ value: i.value, label: i.value, count: i.n })),
    },
    {
      kind: 'select',
      key: 'stage',
      label: 'Lifecycle',
      options: [
        { value: 'prospect', label: 'Prospect' },
        { value: 'opportunity', label: 'Opportunity' },
        { value: 'customer', label: 'Customer' },
        { value: 'churned', label: 'Churned' },
      ],
    },
    {
      kind: 'select',
      key: 'owner',
      label: 'Owner',
      options: facets.owners.map((o) => ({ value: o.id, label: o.name })),
    },
    {
      // Saved-view shortcuts: the three questions people actually open this
      // list to answer.
      kind: 'chips',
      key: 'flag',
      label: 'Views',
      options: [
        { value: 'at_risk', label: 'At risk' },
        { value: 'quiet', label: 'No contact 30d+' },
      ],
    },
  ];

  return (
    <FilterBar
      filters={filters}
      current={current}
      sortOptions={[
        { value: 'pipeline', label: 'Open pipeline' },
        { value: 'health', label: 'Health' },
        { value: 'arr', label: 'ARR' },
        { value: 'activity', label: 'Last contact' },
        { value: 'name', label: 'Name' },
      ]}
    />
  );
}
