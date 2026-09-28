'use client';

import * as React from 'react';
import Link from 'next/link';
import type { getAccountDetail, getAccountTimeline, getRelationshipGraph } from '@/server/crm/accounts';
import { Tabs } from '@/components/ui/feedback';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DetailRow,
  EmptyState,
  HealthScore,
  SectionLabel,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { EvidenceQuote } from '@/components/ai/citation';
import { RelationshipGraph } from '@/components/crm/relationship-graph';
import { Timeline } from '@/components/crm/timeline';
import { CommitmentRow } from '@/components/crm/commitment-row';
import { NavIcon } from '@/components/layout/icons';
import { dayMonth, money, moneyShort, relativeTime, shortDate, titleCase } from '@/lib/utils';

type Detail = Awaited<ReturnType<typeof getAccountDetail>>;
type TimelineRows = Awaited<ReturnType<typeof getAccountTimeline>>;
type Graph = Awaited<ReturnType<typeof getRelationshipGraph>>;

const BUYING_ROLE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  champion: 'success',
  economic_buyer: 'accent',
  decision_maker: 'accent',
  technical_evaluator: 'info',
  blocker: 'danger',
  influencer: 'neutral',
  end_user: 'neutral',
  unknown: 'neutral',
};

export function AccountTabs({
  detail,
  timeline,
  graph,
}: {
  detail: Detail;
  timeline: TimelineRows;
  graph: Graph;
}) {
  const [tab, setTab] = React.useState('timeline');

  const tabs = [
    { id: 'timeline', label: 'Timeline', count: timeline.length },
    { id: 'people', label: 'Contacts', count: detail.contacts.length },
    { id: 'deals', label: 'Deals', count: detail.opportunities.length },
    { id: 'commitments', label: 'Commitments', count: detail.commitments.length },
    { id: 'concerns', label: 'Concerns', count: detail.objections.length },
    { id: 'emails', label: 'Emails', count: detail.emails.length },
    { id: 'meetings', label: 'Meetings', count: detail.meetings.length },
    { id: 'signals', label: 'Product signals', count: detail.signals.length },
    { id: 'graph', label: 'Relationships' },
    { id: 'memory', label: 'AI memory', count: detail.facts.length },
  ];

  return (
    <div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="mt-4">
        {tab === 'timeline' && <Timeline events={timeline} />}
        {tab === 'people' && <People contacts={detail.contacts} />}
        {tab === 'deals' && <Deals deals={detail.opportunities} />}
        {tab === 'commitments' && <Commitments commitments={detail.commitments} />}
        {tab === 'concerns' && <Concerns objections={detail.objections} />}
        {tab === 'emails' && <Emails emails={detail.emails} />}
        {tab === 'meetings' && <Meetings meetings={detail.meetings} />}
        {tab === 'signals' && <Signals signals={detail.signals} />}
        {tab === 'graph' && <RelationshipGraph graph={graph} />}
        {tab === 'memory' && <Memory detail={detail} />}
      </div>
    </div>
  );
}

/* ── Contacts ─────────────────────────────────────────────────────────────── */

function People({ contacts }: { contacts: Detail['contacts'] }) {
  if (contacts.length === 0) {
    return <EmptyState icon={<NavIcon name="users" />} title="No contacts on this account" />;
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <Thead>
          <Tr className="hover:bg-transparent">
            <Th>Name</Th>
            <Th>Buying role</Th>
            <Th>Title</Th>
            <Th align="right">Influence</Th>
            <Th align="right">Last contact</Th>
          </Tr>
        </Thead>
        <Tbody>
          {contacts.map((contact) => (
            <Tr key={contact.id}>
              <Td>
                <Link href={`/contacts/${contact.id}`} className="group block min-w-0">
                  <span className="block truncate text-sm font-medium text-text group-hover:text-accent-text">
                    {contact.firstName} {contact.lastName}
                    {contact.isPrimary && (
                      <Badge tone="outline" className="ml-1.5 align-middle">
                        Primary
                      </Badge>
                    )}
                  </span>
                  {contact.email && (
                    <span className="block truncate text-2xs text-text-subtle">{contact.email}</span>
                  )}
                </Link>
              </Td>
              <Td>
                {contact.buyingRole && contact.buyingRole !== 'unknown' ? (
                  <Badge tone={BUYING_ROLE_TONE[contact.buyingRole] ?? 'neutral'}>
                    {titleCase(contact.buyingRole)}
                  </Badge>
                ) : (
                  <span className="text-2xs text-text-subtle">Not identified</span>
                )}
              </Td>
              <Td>
                <span className="text-xs text-text-muted">{contact.title ?? '—'}</span>
              </Td>
              <Td align="right">
                <span className="text-xs text-text-muted">{contact.influence ?? '—'}</span>
              </Td>
              <Td align="right">
                <span className="text-xs text-text-muted">
                  {relativeTime(contact.lastInteractionAt)}
                </span>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}

/* ── Deals ────────────────────────────────────────────────────────────────── */

function Deals({ deals }: { deals: Detail['opportunities'] }) {
  if (deals.length === 0) {
    return <EmptyState icon={<NavIcon name="target" />} title="No deals on this account" />;
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <Thead>
          <Tr className="hover:bg-transparent">
            <Th>Deal</Th>
            <Th>Stage</Th>
            <Th>Health</Th>
            <Th align="right">Value</Th>
            <Th align="right">Expected close</Th>
            <Th align="right">Last contact</Th>
          </Tr>
        </Thead>
        <Tbody>
          {deals.map((deal) => (
            <Tr key={deal.id}>
              <Td>
                <Link
                  href={`/opportunities/${deal.id}`}
                  className="block truncate text-sm font-medium text-text hover:text-accent-text"
                >
                  {deal.name}
                </Link>
              </Td>
              <Td>
                <Badge
                  tone={deal.status === 'won' ? 'success' : deal.status === 'lost' ? 'danger' : 'neutral'}
                >
                  {deal.stageName}
                </Badge>
              </Td>
              <Td>
                <HealthScore score={deal.healthScore} showBar={false} />
              </Td>
              <Td align="right">
                <span className="text-sm text-text">{money(deal.value)}</span>
              </Td>
              <Td align="right">
                <span className="text-xs text-text-muted">{shortDate(deal.expectedCloseDate)}</span>
              </Td>
              <Td align="right">
                <span className="text-xs text-text-muted">{relativeTime(deal.lastInteractionAt)}</span>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}

/* ── Commitments ──────────────────────────────────────────────────────────── */

function Commitments({ commitments }: { commitments: Detail['commitments'] }) {
  if (commitments.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="check" />}
        title="No open commitments"
        description="Promises made in emails and meetings are extracted here automatically."
      />
    );
  }

  const ours = commitments.filter((c) => c.direction === 'we_owe');
  const theirs = commitments.filter((c) => c.direction === 'they_owe');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>What we owe them · {ours.length}</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          {ours.length === 0 ? (
            <p className="text-xs text-text-subtle">Nothing outstanding on our side.</p>
          ) : (
            <ul className="space-y-3">
              {ours.map((c) => (
                <CommitmentRow key={c.id} commitment={c} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What they owe us · {theirs.length}</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          {theirs.length === 0 ? (
            <p className="text-xs text-text-subtle">Nothing outstanding on their side.</p>
          ) : (
            <ul className="space-y-3">
              {theirs.map((c) => (
                <CommitmentRow key={c.id} commitment={c} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ── Concerns ─────────────────────────────────────────────────────────────── */

function Concerns({ objections }: { objections: Detail['objections'] }) {
  if (objections.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="sparkles" />}
        title="No concerns recorded"
        description="Objections are extracted from what the customer actually said, with the quote kept."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {objections.map((objection) => (
        <Card as="li" key={objection.id}>
          <CardBody className="pt-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
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
                  <Badge tone={objection.status === 'open' ? 'outline' : 'success'}>
                    {titleCase(objection.status)}
                  </Badge>
                  <span className="text-2xs text-text-subtle">
                    {dayMonth(objection.occurredAt)} · {Math.round(objection.confidence * 100)}%
                    confidence
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-text text-pretty">{objection.summary}</p>
              </div>
            </div>

            <EvidenceQuote
              className="mt-2.5"
              quote={objection.sourceQuote}
              source={
                objection.sourceType && objection.sourceId
                  ? {
                      type: objection.sourceType as 'email' | 'transcript' | 'meeting',
                      id: objection.sourceId,
                      label: 'Source',
                      occurredAt: objection.occurredAt.toISOString(),
                    }
                  : undefined
              }
            />
          </CardBody>
        </Card>
      ))}
    </ul>
  );
}

/* ── Emails ───────────────────────────────────────────────────────────────── */

function Emails({ emails }: { emails: Detail['emails'] }) {
  if (emails.length === 0) {
    return <EmptyState icon={<NavIcon name="inbox" />} title="No email on this account" />;
  }

  return (
    <ul className="space-y-2">
      {emails.map((email) => (
        <Card as="li" key={email.id}>
          <CardBody className="pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge tone={email.direction === 'inbound' ? 'info' : 'neutral'}>
                  {email.direction === 'inbound' ? 'Received' : 'Sent'}
                </Badge>
                <p className="min-w-0 truncate text-sm font-medium text-text">{email.subject}</p>
              </div>
              <span className="shrink-0 text-2xs text-text-subtle">
                {shortDate(email.sentAt)}
              </span>
            </div>
            <p className="mt-1 text-2xs text-text-subtle">
              {email.fromName ?? email.fromEmail}
              {email.sentiment != null && Math.abs(email.sentiment) > 0.2 && (
                <span className={email.sentiment > 0 ? ' text-success-text' : ' text-danger-text'}>
                  {' '}
                  · {email.sentiment > 0 ? 'positive' : 'negative'} tone
                </span>
              )}
            </p>
            {email.snippet && (
              <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-text-muted text-pretty">
                {email.snippet}
              </p>
            )}
          </CardBody>
        </Card>
      ))}
    </ul>
  );
}

/* ── Meetings ─────────────────────────────────────────────────────────────── */

function Meetings({ meetings }: { meetings: Detail['meetings'] }) {
  if (meetings.length === 0) {
    return <EmptyState icon={<NavIcon name="calendar" />} title="No meetings on this account" />;
  }

  return (
    <ul className="space-y-2.5">
      {meetings.map((meeting) => (
        <Card as="li" key={meeting.id}>
          <CardBody className="pt-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={`/meetings/${meeting.id}`}
                className="min-w-0 truncate text-sm font-medium text-text hover:text-accent-text"
              >
                {meeting.title}
              </Link>
              <div className="flex shrink-0 items-center gap-1.5">
                {meeting.intelligence?.sentimentLabel && (
                  <Badge
                    tone={
                      meeting.intelligence.sentimentLabel === 'positive'
                        ? 'success'
                        : meeting.intelligence.sentimentLabel === 'negative'
                          ? 'danger'
                          : meeting.intelligence.sentimentLabel === 'mixed'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {meeting.intelligence.sentimentLabel}
                  </Badge>
                )}
                <span className="text-2xs text-text-subtle">{shortDate(meeting.startsAt)}</span>
              </div>
            </div>

            {meeting.intelligence?.summary && (
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted text-pretty">
                {meeting.intelligence.summary}
              </p>
            )}

            {meeting.intelligence && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {meeting.intelligence.objections.length > 0 && (
                  <Badge tone="warning">{meeting.intelligence.objections.length} objections</Badge>
                )}
                {meeting.intelligence.productRequests.length > 0 && (
                  <Badge tone="info">{meeting.intelligence.productRequests.length} requests</Badge>
                )}
                {meeting.intelligence.nextSteps.length > 0 && (
                  <Badge tone="neutral">{meeting.intelligence.nextSteps.length} next steps</Badge>
                )}
                {meeting.intelligence.competitorsMentioned.length > 0 && (
                  <Badge tone="danger">
                    {meeting.intelligence.competitorsMentioned.join(', ')}
                  </Badge>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      ))}
    </ul>
  );
}

/* ── Product signals ──────────────────────────────────────────────────────── */

function Signals({ signals }: { signals: Detail['signals'] }) {
  if (signals.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="signal" />}
        title="No product signals"
        description="Feature requests, integration asks and security requirements are extracted from conversations."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {signals.map((signal) => (
        <Card as="li" key={signal.id}>
          <CardBody className="pt-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
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
                  <Badge tone="outline">{titleCase(signal.category)}</Badge>
                  <span className="text-2xs text-text-subtle">{dayMonth(signal.occurredAt)}</span>
                </div>
                <p className="mt-1.5 text-sm font-medium text-text">{signal.title}</p>
                {signal.detail && (
                  <p className="mt-0.5 text-xs text-text-muted text-pretty">{signal.detail}</p>
                )}
              </div>
            </div>

            <EvidenceQuote
              className="mt-2.5"
              quote={signal.sourceQuote}
              source={
                signal.sourceType && signal.sourceId
                  ? {
                      type: signal.sourceType as 'email' | 'transcript' | 'meeting',
                      id: signal.sourceId,
                      label: 'Source',
                      occurredAt: signal.occurredAt.toISOString(),
                    }
                  : undefined
              }
            />
          </CardBody>
        </Card>
      ))}
    </ul>
  );
}

/* ── AI memory (temporal facts) ───────────────────────────────────────────── */

function Memory({ detail }: { detail: Detail }) {
  const changedKeys = new Set(detail.changedFactKeys.map((c) => c.key));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Known facts</CardTitle>
            <p className="mt-0.5 text-2xs text-text-subtle">
              Extracted from conversations. Values are versioned — nothing is overwritten.
            </p>
          </div>
        </CardHeader>
        <CardBody className="pt-0">
          {detail.facts.length === 0 ? (
            <p className="text-xs text-text-subtle">
              No structured facts extracted yet. Budgets, timelines and decision processes appear
              here once a customer states them.
            </p>
          ) : (
            <ul className="space-y-3.5">
              {detail.facts.map((fact) => (
                <li key={fact.id} className="min-w-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs font-medium text-text">{fact.label}</p>
                    <div className="flex items-center gap-1.5">
                      {changedKeys.has(fact.key) && (
                        <Badge
                          tone="info"
                          title="This value has changed at least once. The history is preserved."
                        >
                          changed
                        </Badge>
                      )}
                      <span className="text-2xs text-text-subtle">
                        {Math.round(fact.confidence * 100)}% confidence
                      </span>
                    </div>
                  </div>
                  <p className="mt-0.5 text-sm text-text">
                    {fact.valueNumber != null
                      ? fact.unit === 'USD'
                        ? money(fact.valueNumber)
                        : `${fact.valueNumber.toLocaleString()}${fact.unit ? ` ${fact.unit}` : ''}`
                      : (fact.valueText ?? '—')}
                  </p>
                  <p className="mt-0.5 text-2xs text-text-subtle">
                    Known since {shortDate(fact.validFrom)} · from {fact.sourceType ?? 'manual entry'}
                  </p>
                  <EvidenceQuote className="mt-1.5" quote={fact.sourceQuote} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What has changed</CardTitle>
        </CardHeader>
        <CardBody className="pt-0">
          {detail.changedFactKeys.length === 0 ? (
            <p className="text-xs text-text-subtle">
              No fact has changed value yet. When one does, both the current value and the full
              history stay queryable.
            </p>
          ) : (
            <dl>
              {detail.changedFactKeys.map((change) => (
                <DetailRow key={change.key} label={change.label}>
                  {change.changes} recorded values
                </DetailRow>
              ))}
            </dl>
          )}

          <p className="mt-4 rounded-[var(--radius-md)] bg-bg-subtle px-3 py-2 text-2xs leading-relaxed text-text-muted text-pretty">
            Facts are stored bitemporally: each carries when it became true and when we learned it.
            That is what lets Bolt answer both &ldquo;what is their budget?&rdquo; and &ldquo;how has
            it changed?&rdquo;
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
