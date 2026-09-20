import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, requireCtx } from '@/server/context';
import { getContactDetail } from '@/server/crm/contacts';
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
  HealthScore,
  SectionLabel,
  Stat,
} from '@/components/ui/primitives';
import { AskInline } from '@/components/ai/ask-inline';
import { CitationList, EvidenceQuote } from '@/components/ai/citation';
import { CommitmentRow } from '@/components/crm/commitment-row';
import { Timeline } from '@/components/crm/timeline';
import { ActionButtons } from '@/components/ai/action-buttons';
import { Mail, NavIcon, Phone } from '@/components/layout/icons';
import { money, relativeTime, shortDate, titleCase } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireCtx();
    const { contact } = await getContactDetail(ctx, id);
    return { title: `${contact.firstName} ${contact.lastName}` };
  } catch {
    return { title: 'Contact' };
  }
}

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();

  let detail: Awaited<ReturnType<typeof getContactDetail>>;
  try {
    detail = await getContactDetail(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { contact, account } = detail;
  const name = `${contact.firstName} ${contact.lastName}`;
  const memory = contact.memorySummary;

  return (
    <PageShell>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3.5">
          <Avatar name={name} size="lg" />
          <div className="min-w-0">
            <nav className="mb-1 flex items-center gap-1.5 text-2xs text-text-subtle">
              <Link href="/contacts" className="hover:text-text">
                Contacts
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

            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-text">{name}</h1>
              {contact.buyingRole && contact.buyingRole !== 'unknown' && (
                <Badge
                  tone={
                    contact.buyingRole === 'champion'
                      ? 'success'
                      : contact.buyingRole === 'blocker'
                        ? 'danger'
                        : contact.buyingRole === 'economic_buyer' || contact.buyingRole === 'decision_maker'
                          ? 'accent'
                          : 'info'
                  }
                  size="md"
                >
                  {titleCase(contact.buyingRole)}
                </Badge>
              )}
              {contact.isPrimary && <Badge tone="outline">Primary contact</Badge>}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
              {contact.title && <span>{contact.title}</span>}
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="inline-flex items-center gap-1 hover:text-accent-text"
                >
                  <Mail className="size-3" />
                  {contact.email}
                </a>
              )}
              {contact.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone className="size-3" />
                  {contact.phone}
                </span>
              )}
              {contact.location && <span>{contact.location}</span>}
            </div>
          </div>
        </div>

        <ActionButtons
          size="sm"
          actions={[
            { label: 'Draft email', kind: 'draft_email', payload: { purpose: 'check in' } },
            { label: 'Create task', kind: 'create_task', payload: { title: `Follow up with ${name}` } },
          ]}
          context={{ accountId: account?.id ?? null, contactId: contact.id }}
        />
      </div>

      {/* ── Vitals ────────────────────────────────────────────────────── */}
      <Card className="mt-5">
        <CardBody className="grid grid-cols-2 gap-5 pt-4 sm:grid-cols-4">
          <Stat
            label="Last contact"
            value={relativeTime(contact.lastInteractionAt)}
            tone={
              contact.lastInteractionAt &&
              Date.now() - contact.lastInteractionAt.getTime() > 30 * 86_400_000
                ? 'danger'
                : 'neutral'
            }
          />
          <Stat label="Influence" value={contact.influence != null ? `${contact.influence}/100` : '—'} />
          <Stat
            label="Sentiment"
            value={
              contact.sentiment == null
                ? '—'
                : contact.sentiment > 0.2
                  ? 'Positive'
                  : contact.sentiment < -0.2
                    ? 'Negative'
                    : 'Neutral'
            }
            tone={
              contact.sentiment == null
                ? 'neutral'
                : contact.sentiment > 0.2
                  ? 'success'
                  : contact.sentiment < -0.2
                    ? 'danger'
                    : 'neutral'
            }
          />
          <div className="min-w-0">
            <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">
              Account health
            </p>
            <div className="mt-1.5">
              <HealthScore score={account?.healthScore} showBar={false} />
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="mt-5">
        <AskInline
          placeholder={`Ask about ${name}…`}
          scopeType="contact"
          scopeId={contact.id}
          scopeLabel={name}
          suggestions={[`What has ${contact.firstName} raised?`, `What did ${contact.firstName} commit to?`]}
        />
      </div>

      {/* ── Memory + detail ───────────────────────────────────────────── */}
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {memory ? (
            <Card>
              <CardHeader>
                <CardTitle>What we know</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <p className="text-sm leading-relaxed text-text text-pretty">{memory.summary}</p>

                {memory.priorities.length > 0 && (
                  <div className="mt-4">
                    <SectionLabel>What they care about</SectionLabel>
                    <ul className="mt-1.5 space-y-1.5">
                      {memory.priorities.map((item, i) => (
                        <li key={i} className="flex gap-2 text-xs text-text-muted text-pretty">
                          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-text-subtle" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {memory.concerns.length > 0 && (
                  <div className="mt-4">
                    <SectionLabel>Concerns they have raised</SectionLabel>
                    <ul className="mt-1.5 space-y-1.5">
                      {memory.concerns.map((item, i) => (
                        <li key={i} className="flex gap-2 text-xs text-text-muted text-pretty">
                          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-warning" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {memory.communicationStyle && (
                  <div className="mt-4">
                    <SectionLabel>How they communicate</SectionLabel>
                    <p className="mt-1 text-xs text-text-muted text-pretty">
                      {memory.communicationStyle}
                    </p>
                  </div>
                )}

                {memory.sources.length > 0 && (
                  <div className="mt-4 border-t border-border pt-3">
                    <CitationList sources={memory.sources} numbered={false} />
                  </div>
                )}
              </CardBody>
            </Card>
          ) : (
            <EmptyState
              icon={<NavIcon name="sparkles" />}
              title="No summary yet"
              description="A contact summary is built once there are recorded conversations involving this person."
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              {detail.timeline.length === 0 ? (
                <p className="text-xs text-text-subtle">Nothing recorded yet.</p>
              ) : (
                <Timeline events={detail.timeline} />
              )}
            </CardBody>
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardBody className="pt-0">
              <dl>
                <DetailRow label="Seniority">
                  {contact.seniority ? titleCase(contact.seniority) : '—'}
                </DetailRow>
                <DetailRow label="Department">{contact.department ?? '—'}</DetailRow>
                <DetailRow label="Owner">{detail.ownerName ?? '—'}</DetailRow>
                <DetailRow label="Created">{shortDate(contact.createdAt)}</DetailRow>
                {contact.linkedinUrl && (
                  <DetailRow label="LinkedIn">
                    <a
                      href={contact.linkedinUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent-text hover:underline"
                    >
                      Profile
                    </a>
                  </DetailRow>
                )}
              </dl>
            </CardBody>
          </Card>

          {detail.commitments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Their commitments</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="space-y-3">
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

          {detail.opportunities.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Deals on this account</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="space-y-2">
                  {detail.opportunities.map((deal) => (
                    <li key={deal.id}>
                      <Link href={`/opportunities/${deal.id}`} className="group block min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-xs font-medium text-text group-hover:text-accent-text">
                            {deal.name}
                          </span>
                          <span className="shrink-0 text-xs tabular text-text-muted">
                            {money(deal.value)}
                          </span>
                        </div>
                        <div className="mt-0.5">
                          <HealthScore score={deal.healthScore} showBar={false} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {detail.meetings.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Meetings attended</CardTitle>
              </CardHeader>
              <CardBody className="pt-0">
                <ul className="space-y-2">
                  {detail.meetings.slice(0, 8).map((meeting) => (
                    <li key={meeting.id}>
                      <Link href={`/meetings/${meeting.id}`} className="group block min-w-0">
                        <span className="block truncate text-xs text-text group-hover:text-accent-text">
                          {meeting.title}
                        </span>
                        <span className="text-2xs text-text-subtle">
                          {shortDate(meeting.startsAt)}
                          {meeting.talkRatio != null &&
                            ` · ${Math.round(meeting.talkRatio * 100)}% of speaking time`}
                        </span>
                      </Link>
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
