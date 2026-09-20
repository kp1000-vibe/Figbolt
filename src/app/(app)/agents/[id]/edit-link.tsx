'use client';

import Link from 'next/link';
import { Sliders } from '@/components/layout/icons';

export function AgentEditLink({ agentId }: { agentId: string }) {
  return (
    <Link
      href={`/agents/${agentId}/edit`}
      className="inline-flex h-7.5 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 text-xs font-medium text-text shadow-[var(--shadow-sm)] hover:bg-surface-hover"
    >
      <Sliders className="size-3.5" />
      Edit
    </Link>
  );
}
