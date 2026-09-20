'use client';

import * as React from 'react';
import type { CrmEventType } from '@/db/schema';
import { Badge, Card, EmptyState } from '@/components/ui/primitives';
import { NavIcon } from '@/components/layout/icons';
import { cn, relativeTime, shortDate, timeOfDay, titleCase } from '@/lib/utils';

/**
 * The relationship timeline.
 *
 * This is the "what changed" feed, not the "what happened" feed — it carries
 * state changes (an objection appeared, a stakeholder was discovered, sentiment
 * moved), which is what makes it readable at all. Routine email traffic would
 * bury the three events that matter, so importance is filterable and the
 * default hides the noise.
 */

type Event = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  importance: number;
  occurredAt: Date;
  actorType: string;
  actorLabel: string | null;
  metadata: Record<string, unknown> | null;
  sourceType: string | null;
  sourceId: string | null;
};

const ICON_FOR_TYPE: Partial<Record<CrmEventType, Parameters<typeof NavIcon>[0]['name']>> = {
  email_sent: 'inbox',
  email_received: 'inbox',
  meeting_happened: 'calendar',
  meeting_scheduled: 'calendar',
  call_logged: 'inbox',
  stage_changed: 'target',
  objection_identified: 'signal',
  commitment_made: 'check',
  commitment_fulfilled: 'check',
  feature_requested: 'signal',
  competitor_mentioned: 'signal',
  pricing_discussed: 'chart',
  stakeholder_discovered: 'users',
  risk_detected: 'signal',
  record_created: 'building',
  field_updated: 'settings',
  task_completed: 'check',
  note_added: 'book',
  sentiment_changed: 'signal',
  contract_sent: 'book',
  renewal_discussed: 'chart',
};

const TONE_FOR_TYPE: Partial<Record<string, 'success' | 'warning' | 'danger' | 'accent' | 'info' | 'neutral'>> = {
  objection_identified: 'warning',
  competitor_mentioned: 'danger',
  risk_detected: 'danger',
  commitment_made: 'accent',
  commitment_fulfilled: 'success',
  stage_changed: 'accent',
  feature_requested: 'info',
  pricing_discussed: 'warning',
  stakeholder_discovered: 'info',
};

export function Timeline({ events }: { events: Event[] }) {
  const [minImportance, setMinImportance] = React.useState(1);

  const filtered = React.useMemo(
    () => events.filter((e) => e.importance >= minImportance),
    [events, minImportance],
  );

  // Group by calendar day so the eye scans dates, not rows.
  const groups = React.useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const event of filtered) {
      const key = event.occurredAt.toISOString().slice(0, 10);
      const existing = map.get(key);
      if (existing) existing.push(event);
      else map.set(key, [event]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  if (events.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="book" />}
        title="Nothing on the timeline yet"
        description="Timeline events are written as the memory engine detects changes in the relationship."
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-2xs text-text-subtle">Show</span>
        {[
          { value: 1, label: 'Everything' },
          { value: 3, label: 'Notable' },
          { value: 4, label: 'Significant only' },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={minImportance === option.value}
            onClick={() => setMinImportance(option.value)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-2xs transition-colors',
              minImportance === option.value
                ? 'border-accent-border bg-accent-subtle font-medium text-accent-text'
                : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
            )}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto text-2xs text-text-subtle">
          {filtered.length} of {events.length} events
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-border px-4 py-8 text-center text-xs text-text-subtle">
          No events at this importance level.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map(([day, dayEvents]) => (
            <div key={day}>
              <div className="mb-2 flex items-center gap-2">
                <p className="text-2xs font-semibold tracking-wide text-text-subtle uppercase">
                  {shortDate(day)}
                </p>
                <span className="text-2xs text-text-subtle">· {relativeTime(day)}</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <ul className="space-y-1.5">
                {dayEvents.map((event) => {
                  const tone = TONE_FOR_TYPE[event.type] ?? 'neutral';
                  return (
                    <Card as="li" key={event.id} className="overflow-hidden">
                      <div className="flex items-start gap-3 px-3.5 py-2.5">
                        <span
                          className={cn(
                            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
                            tone === 'danger' && 'bg-danger-subtle text-danger-text',
                            tone === 'warning' && 'bg-warning-subtle text-warning-text',
                            tone === 'success' && 'bg-success-subtle text-success-text',
                            tone === 'accent' && 'bg-accent-subtle text-accent-text',
                            tone === 'info' && 'bg-info-subtle text-info-text',
                            tone === 'neutral' && 'bg-bg-muted text-text-subtle',
                          )}
                        >
                          <NavIcon
                            name={ICON_FOR_TYPE[event.type as CrmEventType] ?? 'book'}
                            className="size-3.5"
                          />
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="min-w-0 text-xs font-medium text-text text-pretty">
                              {event.title}
                            </p>
                            <span className="shrink-0 text-2xs tabular text-text-subtle">
                              {timeOfDay(event.occurredAt)}
                            </span>
                          </div>

                          {event.body && (
                            <p className="mt-1 line-clamp-3 text-2xs leading-relaxed text-text-muted text-pretty">
                              {event.body}
                            </p>
                          )}

                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge tone="outline">{titleCase(event.type)}</Badge>
                            {event.actorType === 'agent' && (
                              <Badge tone="accent">Agent · {event.actorLabel}</Badge>
                            )}
                            {event.actorType === 'system' && <Badge tone="neutral">Automated</Badge>}
                            {event.importance >= 4 && <Badge tone="warning">High signal</Badge>}
                          </div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
