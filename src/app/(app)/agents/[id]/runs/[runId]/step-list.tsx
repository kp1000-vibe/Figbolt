'use client';

import * as React from 'react';
import type { RiskLevel, SourceRef } from '@/db/schema';
import { Badge, Card } from '@/components/ui/primitives';
import { CitationChip } from '@/components/ai/citation';
import { ChevronDown, ChevronRight, NavIcon } from '@/components/layout/icons';
import { cn, number, titleCase } from '@/lib/utils';

/**
 * The step trace.
 *
 * Inputs and outputs are shown verbatim, because the point of this page is to
 * let someone audit a tool call rather than read a description of one. Steps
 * that were held for approval or that errored are expanded by default — those
 * are the ones a person opened this page to look at.
 */

type Step = {
  id: string;
  index: number;
  kind: string;
  title: string;
  tool: string | null;
  input: unknown;
  output: unknown;
  status: string;
  error: string | null;
  riskLevel: RiskLevel | null;
  sources: SourceRef[];
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

const KIND_ICON: Record<string, Parameters<typeof NavIcon>[0]['name']> = {
  plan: 'workflow',
  retrieve: 'building',
  tool_call: 'settings',
  model_call: 'sparkles',
  approval: 'bot',
  result: 'check',
  error: 'signal',
};

export function StepList({ steps }: { steps: Step[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set(steps.filter((s) => s.status !== 'ok').map((s) => s.id)),
  );

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (steps.length === 0) {
    return (
      <p className="rounded-[var(--radius-lg)] border border-dashed border-border px-4 py-8 text-center text-xs text-text-subtle">
        No steps recorded for this run.
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {steps.map((step) => {
        const isOpen = expanded.has(step.id);
        const tone =
          step.status === 'error'
            ? 'danger'
            : step.status === 'awaiting_approval'
              ? 'warning'
              : step.status === 'denied'
                ? 'danger'
                : step.kind === 'model_call'
                  ? 'accent'
                  : 'neutral';

        return (
          <Card as="li" key={step.id} className="overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(step.id)}
              aria-expanded={isOpen}
              className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left"
            >
              <span className="mt-0.5 shrink-0 text-text-subtle">
                {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </span>

              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                  tone === 'danger' && 'bg-danger-subtle text-danger-text',
                  tone === 'warning' && 'bg-warning-subtle text-warning-text',
                  tone === 'accent' && 'bg-accent-subtle text-accent-text',
                  tone === 'neutral' && 'bg-bg-muted text-text-subtle',
                )}
              >
                <NavIcon name={KIND_ICON[step.kind] ?? 'book'} className="size-3" />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-1.5">
                  <span className="font-mono text-[10px] text-text-subtle">
                    {String(step.index).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 text-xs font-medium text-text">{step.title}</span>
                  <Badge tone="outline">{step.kind.replace('_', ' ')}</Badge>
                  {step.riskLevel && step.riskLevel !== 'low' && (
                    <Badge tone={step.riskLevel === 'high' ? 'danger' : 'warning'}>
                      {step.riskLevel} risk
                    </Badge>
                  )}
                  {step.status === 'awaiting_approval' && (
                    <Badge tone="warning">Held for approval — not performed</Badge>
                  )}
                  {step.status === 'denied' && <Badge tone="danger">Rejected</Badge>}
                  {step.status === 'error' && <Badge tone="danger">Error</Badge>}
                </span>

                <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 font-mono text-[10px] text-text-subtle">
                  {step.tool && <span>{step.tool}</span>}
                  {step.latencyMs != null && <span>{step.latencyMs}ms</span>}
                  {(step.promptTokens ?? 0) + (step.completionTokens ?? 0) > 0 && (
                    <span>
                      {number((step.promptTokens ?? 0) + (step.completionTokens ?? 0))} tokens
                    </span>
                  )}
                </span>
              </span>
            </button>

            {isOpen && (
              <div className="border-t border-border bg-bg-subtle px-3.5 py-2.5">
                {step.error && (
                  <div className="mb-2.5 rounded-[var(--radius-sm)] border border-danger/25 bg-danger-subtle px-2.5 py-1.5">
                    <p className="font-mono text-[10px] break-words text-danger-text">{step.error}</p>
                  </div>
                )}

                {step.input != null && (
                  <div className="mb-2.5">
                    <p className="mb-1 text-[10px] font-semibold tracking-wide text-text-subtle uppercase">
                      Input
                    </p>
                    <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-surface px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-text-muted">
                      {stringify(step.input)}
                    </pre>
                  </div>
                )}

                {step.output != null && (
                  <div>
                    <p className="mb-1 text-[10px] font-semibold tracking-wide text-text-subtle uppercase">
                      Output
                    </p>
                    <pre className="max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-surface px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-text-muted">
                      {stringify(step.output)}
                    </pre>
                  </div>
                )}

                {step.sources.length > 0 && (
                  <div className="mt-2.5">
                    <p className="mb-1 text-[10px] font-semibold tracking-wide text-text-subtle uppercase">
                      Records touched
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {step.sources.slice(0, 12).map((source, i) => (
                        <CitationChip key={i} source={source} />
                      ))}
                    </div>
                  </div>
                )}

                {step.input == null && step.output == null && !step.error && (
                  <p className="text-[10px] text-text-subtle">No payload recorded for this step.</p>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </ol>
  );
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
