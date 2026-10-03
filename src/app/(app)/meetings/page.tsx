import Link from 'next/link';
import { requireCtx } from '@/server/context';
import { listMeetings, meetingCounts } from '@/server/crm/meetings';
import { PageShell } from '@/components/layout/app-shell';
import { Badge, Card, CardBody, EmptyState, PageHeader } from '@/components/ui/primitives';
import { MeetingFilters } from './filters';
import { ScheduleMeetingButton } from './schedule-form';
import { NavIcon } from '@/components/layout/icons';
import { number, shortDate, timeOfDay } from '@/lib/utils';

export const metadata = { title: 'Meetings' };

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [meetings, counts] = await Promise.all([
    listMeetings(ctx, { query: params['q'], bucket: params['bucket'], limit: 100 }),
    meetingCounts(ctx),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Meetings"
        description={`${number(counts.total)} recorded · ${number(counts.past)} with intelligence extracted from the transcript`}
        actions={<ScheduleMeetingButton />}
      />

      <div className="mt-5">
        <MeetingFilters current={params} counts={counts} />
      </div>

      {meetings.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<NavIcon name="calendar" />}
          title="No meetings match"
          description="Connect a calendar in Integrations to sync meetings, or clear the filter."
        />
      ) : (
        <ul className="mt-4 space-y-2.5">
          {meetings.map((meeting) => {
            const intel = meeting.intelligence;
            return (
              <Card as="li" key={meeting.id}>
                <CardBody className="pt-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/meetings/${meeting.id}`}
                        className="inline-block py-0.5 text-sm font-medium text-text hover:text-accent-text"
                      >
                        {meeting.title}
                      </Link>
                      <p className="mt-0.5 text-2xs text-text-subtle">
                        {shortDate(meeting.startsAt)} · {timeOfDay(meeting.startsAt)} ·{' '}
                        {meeting.participantCount} participants
                        {meeting.accountName && (
                          <>
                            {' · '}
                            <Link
                              href={`/accounts/${meeting.accountId}`}
                              className="hover:text-accent-text"
                            >
                              {meeting.accountName}
                            </Link>
                          </>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {!meeting.hasTranscript && <Badge tone="neutral">No transcript</Badge>}
                      {!meeting.processedAt && meeting.hasTranscript && (
                        <Badge tone="warning">Not processed</Badge>
                      )}
                      {intel?.sentimentLabel && (
                        <Badge
                          tone={
                            intel.sentimentLabel === 'positive'
                              ? 'success'
                              : intel.sentimentLabel === 'negative'
                                ? 'danger'
                                : intel.sentimentLabel === 'mixed'
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {intel.sentimentLabel}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {intel?.summary && (
                    <p className="mt-2 text-xs leading-relaxed text-text-muted text-pretty">
                      {intel.summary}
                    </p>
                  )}

                  {intel && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {intel.keyDecisions.length > 0 && (
                        <Badge tone="accent">{intel.keyDecisions.length} decisions</Badge>
                      )}
                      {intel.objections.length > 0 && (
                        <Badge tone="warning">{intel.objections.length} objections</Badge>
                      )}
                      {intel.productRequests.length > 0 && (
                        <Badge tone="info">{intel.productRequests.length} product requests</Badge>
                      )}
                      {intel.nextSteps.length > 0 && (
                        <Badge tone="neutral">{intel.nextSteps.length} next steps</Badge>
                      )}
                      {intel.competitorsMentioned.map((competitor) => (
                        <Badge key={competitor} tone="danger">
                          {competitor}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
