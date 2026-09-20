import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, requireCtx } from '@/server/context';
import { getMeetingDetail } from '@/server/crm/meetings';
import { PageShell } from '@/components/layout/app-shell';
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
  EmptyState,
  SectionLabel,
} from '@/components/ui/primitives';
import { CommitmentRow } from '@/components/crm/commitment-row';
import { EvidenceQuote } from '@/components/ai/citation';
import { TranscriptView } from './transcript-view';
import { MeetingActions } from './meeting-actions';
import { AlertTriangle, NavIcon, Play } from '@/components/layout/icons';
import { dayMonth, money, shortDate, timeOfDay, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { meeting } = await getMeetingDetail(ctx, id);
    return { title: meeting.title };
  } catch {
    return { title: 'Meeting' };
  }
}

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getMeetingDetail>>;
  try {
    detail = await getMeetingDetail(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { meeting, transcript, account, opportunity } = detail;
  const intel = meeting.intelligence;
  const durationMinutes = meeting.endsAt
    ? Math.round((meeting.endsAt.getTime() - meeting.startsAt.getTime()) / 60_000)
    : null;

  const customers = detail.participants.filter((p) => p.contactId);
  const internal = detail.participants.filter((p) => p.userId);

  return (
    <PageShell wide>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav className="mb-1.5 flex items-center gap-1.5 text-2xs text-text-subtle">
            <Link href="/meetings" className="hover:text-text">
              Meetings
            </Link>
            {account && (
              <>
                <span>/</span>
                <Link href={`/accounts/${account.id}`} className="hover:text-text">
                  {account.name}
                </Link>
              </>
            )}
          </nav>

          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-text text-balance">
              {meeting.title}
            </h1>
            <Badge
              tone={
                meeting.status === 'completed'
                  ? 'success'
                  : meeting.status === 'cancelled'
                    ? 'danger'
                    : 'neutral'
              }
            >
              {titleCase(meeting.status)}
            </Badge>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            <span>
              {shortDate(meeting.startsAt)} · {timeOfDay(meeting.startsAt)}
            </span>
            {durationMinutes && <span>{durationMinutes} min</span>}
            <span>{detail.participants.length} participants</span>
            {detail.organizerName && <span>Organised by {detail.organizerName}</span>}
            {opportunity && (
              <Link href={`/opportunities/${opportunity.id}`} className="hover:text-accent-text">
                {opportunity.name} · {money(opportunity.value ?? 0)}
              </Link>
            )}
          </div>
        </div>

        <MeetingActions
          meetingId={meeting.id}
          accountId={account?.id ?? null}
          opportunityId={opportunity?.id ?? null}
          hasTranscript={Boolean(transcript)}
          followUp={intel?.followUpDraft ?? null}
        />
      </div>

      {/* ── Recording placeholder ─────────────────────────────────────── */}
      <Card className="mt-5">
        <CardBody className="flex flex-wrap items-center gap-4 pt-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-subtle">
            <Play className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-text">
              {meeting.recordingUrl ? 'Recording available' : 'No recording attached'}
            </p>
            <p className="mt-0.5 text-2xs text-text-muted text-pretty">
              {meeting.recordingUrl
                ? 'Playback is handled by the meeting provider.'
                : 'Connect Zoom or Google Meet in Integrations to attach recordings. Intelligence below is derived from the transcript, which does not require one.'}
            </p>
          </div>
          {meeting.meetingUrl && (
            <a
              href={meeting.meetingUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 text-2xs text-accent-text hover:underline"
            >
              Meeting link
            </a>
          )}
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {/* ── AI summary ────────────────────────────────────────────── */}
          {intel ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>What happened</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    Extracted from the transcript · {Math.round(intel.confidence * 100)}% confidence
                  </p>
                </div>
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
                  size="md"
                >
                  {titleCase(intel.sentimentLabel)}
                </Badge>
              </CardHeader>
              <CardBody className="pt-0">
                <p className="text-sm leading-relaxed text-text text-pretty">{intel.summary}</p>
                {intel.sentimentReason && (
                  <p className="mt-2 text-xs text-text-muted text-pretty">{intel.sentimentReason}</p>
                )}

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <IntelList label="Decisions made" items={intel.keyDecisions} tone="accent" />
                  <IntelList label="Customer pains" items={intel.customerPains} tone="warning" />
                  <IntelList label="Questions asked" items={intel.questions} />
                  <IntelList label="Objections raised" items={intel.objections} tone="danger" />
                  <IntelList label="Product requests" items={intel.productRequests} tone="info" />
                  <IntelList label="Next steps" items={intel.nextSteps} tone="success" />
                </div>

                {intel.pricingDiscussion && (
                  <div className="mt-4">
                    <SectionLabel>Pricing discussion</SectionLabel>
                    <p className="mt-1 text-xs text-text-muted text-pretty">
                      {intel.pricingDiscussion}
                    </p>
                  </div>
                )}

                {intel.competitorsMentioned.length > 0 && (
                  <div className="mt-4">
                    <SectionLabel>Competitors mentioned</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {intel.competitorsMentioned.map((competitor) => (
                        <Badge key={competitor} tone="danger" size="md">
                          {competitor}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          ) : (
            <EmptyState
              icon={<AlertTriangle />}
              title="No intelligence extracted yet"
              description={
                transcript
                  ? 'The transcript is stored but has not been processed. Use "Reprocess" above to run the memory engine over it.'
                  : 'Meeting intelligence requires a transcript. Connect a meeting provider in Integrations to capture them.'
              }
            />
          )}

          {/* ── Transcript ────────────────────────────────────────────── */}
          {transcript && (
            <TranscriptView
              transcript={{
                id: transcript.id,
                segments: transcript.segments,
                durationSeconds: transcript.durationSeconds,
              }}
              commitmentSegments={detail.commitments
                .map((c) => c.sourceSegmentIndex)
                .filter((i): i is number => i != null)}
            />
          )}
        </div>

        {/* ── Right rail ────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Participants</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {customers.length > 0 && (
                <>
                  <SectionLabel>Customer side</SectionLabel>
                  <ul className="mt-1.5 mb-3 space-y-2">
                    {customers.map((person) => (
                      <li key={person.id} className="flex items-center gap-2.5">
                        <Avatar name={person.name ?? person.email} size="sm" />
                        <div className="min-w-0 flex-1">
                          {person.contactId ? (
                            <Link
                              href={`/contacts/${person.contactId}`}
                              className="block truncate text-xs font-medium text-text hover:text-accent-text"
                            >
                              {person.name ?? person.email}
                            </Link>
                          ) : (
                            <span className="block truncate text-xs font-medium text-text">
                              {person.name ?? person.email}
                            </span>
                          )}
                          <span className="block truncate text-2xs text-text-subtle">
                            {person.title ?? person.email}
                          </span>
                        </div>
                        {person.buyingRole && person.buyingRole !== 'unknown' && (
                          <Badge
                            tone={
                              person.buyingRole === 'champion'
                                ? 'success'
                                : person.buyingRole === 'blocker'
                                  ? 'danger'
                                  : 'info'
                            }
                          >
                            {titleCase(person.buyingRole)}
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {internal.length > 0 && (
                <>
                  <SectionLabel>Our side</SectionLabel>
                  <ul className="mt-1.5 space-y-2">
                    {internal.map((person) => (
                      <li key={person.id} className="flex items-center gap-2.5">
                        <Avatar name={person.name ?? person.email} size="sm" />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-text">
                            {person.name ?? person.email}
                          </span>
                          {person.talkRatio != null && (
                            <span className="block text-2xs text-text-subtle">
                              {Math.round(person.talkRatio * 100)}% of speaking time
                            </span>
                          )}
                        </div>
                        {person.isOrganizer && <Badge tone="outline">Organiser</Badge>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardBody>
          </Card>

          {detail.commitments.length > 0 && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Commitments from this meeting</CardTitle>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    Each links back to the line it was extracted from
                  </p>
                </div>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="space-y-3.5">
                  {detail.commitments.map((c) => (
                    <CommitmentRow
                      key={c.id}
                      commitment={{
                        id: c.id,
                        description: c.description,
                        direction: c.direction,
                        ownerLabel: c.ownerLabel,
                        dueAt: c.dueAt,
                        status: c.status,
                        confidence: c.confidence,
                        sourceType: c.sourceType,
                        sourceId: c.sourceId,
                        sourceQuote: c.sourceQuote,
                        taskId: c.taskId,
                        accountId: c.accountId,
                        opportunityId: c.opportunityId,
                      }}
                    />
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {detail.objections.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Objections</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="space-y-3">
                  {detail.objections.map((objection) => (
                    <li key={objection.id}>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          tone={
                            objection.severity === 'high'
                              ? 'danger'
                              : objection.severity === 'medium'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {titleCase(objection.category)}
                        </Badge>
                        <span className="text-2xs text-text-subtle">
                          {Math.round(objection.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text text-pretty">{objection.summary}</p>
                      <EvidenceQuote className="mt-1.5" quote={objection.sourceQuote} />
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {detail.signals.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Product signals</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="space-y-2.5">
                  {detail.signals.map((signal) => (
                    <li key={signal.id} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-xs font-medium text-text">
                          {signal.title}
                        </span>
                        <Badge
                          tone={
                            signal.urgency === 'blocking'
                              ? 'danger'
                              : signal.urgency === 'high'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {signal.urgency === 'blocking' ? 'Blocking' : titleCase(signal.urgency)}
                        </Badge>
                      </div>
                      {signal.detail && (
                        <p className="mt-0.5 text-2xs text-text-muted text-pretty">{signal.detail}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function IntelList({
  label,
  items,
  tone = 'neutral',
}: {
  label: string;
  items: string[];
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'info' | 'success';
}) {
  if (items.length === 0) return null;

  const dot = {
    neutral: 'bg-text-subtle',
    accent: 'bg-accent',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    success: 'bg-success',
  }[tone];

  return (
    <div className="min-w-0">
      <SectionLabel>{label}</SectionLabel>
      <ul className="mt-1.5 space-y-1.5">
        {items.slice(0, 6).map((item, i) => (
          <li key={i} className="flex gap-2 text-xs leading-relaxed text-text-muted text-pretty">
            <span className={`mt-1.5 size-1 shrink-0 rounded-full ${dot}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
