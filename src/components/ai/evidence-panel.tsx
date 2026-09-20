'use client';

import * as React from 'react';
import type { EvidenceItem } from '@/lib/ai/types';
import { Badge, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives';
import { CitationChip } from './citation';
import { ChevronDown, ChevronRight, Shield } from '@/components/layout/icons';
import { cn, truncate } from '@/lib/utils';

/**
 * The evidence panel.
 *
 * Shows exactly what was retrieved and fed to the model, in rank order, with
 * each item's trust classification visible. This is the debugging surface that
 * makes "why did it say that?" answerable — and the place where the untrusted
 * content boundary becomes something a user can see rather than take on faith.
 */
export function EvidencePanel({ evidence }: { evidence: EvidenceItem[] }) {
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set([0]));

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const untrustedCount = evidence.filter((e) => e.trust === 'untrusted').length;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Evidence used</CardTitle>
          <p className="mt-0.5 text-2xs text-text-subtle">
            {evidence.length} records, ranked. {untrustedCount} treated as untrusted.
          </p>
        </div>
      </CardHeader>

      <CardBody className="pt-0">
        <ul className="space-y-1.5">
          {evidence.map((item, index) => {
            const isOpen = expanded.has(index);
            return (
              <li
                key={`${item.ref.type}:${item.ref.id}:${index}`}
                className="rounded-[var(--radius-md)] border border-border bg-bg-subtle"
              >
                <button
                  type="button"
                  onClick={() => toggle(index)}
                  aria-expanded={isOpen}
                  className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
                >
                  <span className="mt-0.5 shrink-0 text-text-subtle">
                    {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] font-semibold text-text-subtle">
                        E{index + 1}
                      </span>
                      <span className="min-w-0 truncate text-xs font-medium text-text">
                        {item.ref.label}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      {item.trust === 'untrusted' ? (
                        <Badge tone="warning" title="Customer-authored content. Treated as data, never as instructions.">
                          <Shield className="size-3" />
                          untrusted
                        </Badge>
                      ) : (
                        <Badge tone="success" title="Workspace-authored content: notes, knowledge, CRM fields.">
                          trusted
                        </Badge>
                      )}
                      {item.score != null && (
                        <span className="font-mono text-[10px] text-text-subtle">
                          score {item.score.toFixed(3)}
                        </span>
                      )}
                    </span>
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-border px-2.5 py-2">
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-2xs leading-relaxed text-text-muted">
                      {truncate(item.content, 4000)}
                    </pre>
                    <div className="mt-2">
                      <CitationChip source={item.ref} index={index + 1} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-2xs leading-relaxed text-text-subtle text-pretty">
          Untrusted content is fenced and labelled in the prompt, and tool permissions are enforced
          independently of anything the model outputs. Prompt structure is defence in depth here, not
          the defence itself.
        </p>
      </CardBody>
    </Card>
  );
}
