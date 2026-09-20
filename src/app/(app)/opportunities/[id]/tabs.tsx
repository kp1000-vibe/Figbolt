'use client';

import * as React from 'react';
import Link from 'next/link';
import type { getOpportunityDetail } from '@/server/crm/opportunities';
import { Tabs } from '@/components/ui/feedback';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@/components/ui/primitives';
import { EvidenceQuote } from '@/components/ai/citation';
import { CommitmentRow } from '@/components/crm/commitment-row';
import { Timeline } from '@/components/crm/timeline';
import { NavIcon } from '@/components/layout/icons';
import { dayMonth, money, relativeTime, shortDate, titleCase } from '@/lib/utils';

type Detail = Awaited<ReturnType<typeof getOpportunityDetail>>;

export function DealTabs({ detail }: { detail: Detail }) {
  const [tab, setTab] = React.useState('timeline');

  const tabs = [
    { id: 'timeline', label: 'Timeline', count: detail.timeline.length },
    { id: 'commitments', label: 'Commitments', count: detail.commitments.length },
    { id: 'objections', label: 'Objections', count: detail.objections.length },
    { id: 'stakeholders', label: 'Stakeholders', count: detail.stakeholders.length },
    { id: 'meetings', label: 'Meetings', count: detail.meetings.length },
    { id: 'emails', label: 'Emails', count: detail.emails.length },
    { id: 'tasks', label: 'Tasks', count: detail.tasks.length },
    { id: 'facts', label: 'Known facts', count: detail.facts.length },
  ];

  return (
    <div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      <div className="mt-4">
        {tab === 'timeline' && <Timeline events={detail.timeline} />}
        {tab === 'commitments' && <Commitments detail={detail} />}
        {tab === 'objections' && <Objections objections={detail.objections} />}
        {tab === 'stakeholders' && <Stakeholders stakeholders={detail.stakeholders} />}
        {tab === 'meetings' && <Meetings meetings={detail.meetings} />}
        {tab === 'emails' && <Emails emails={detail.emails} />}
        {tab === 'tasks' && <TasksList tasks={detail.tasks} />}
        {tab === 'facts' && <Facts facts={detail.facts} />}
      </div>
    </div>
  );
}

function Commitments({ detail }: { detail: Detail }) {
  if (detail.commitments.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="check" />}
        title="No open commitments on this deal"
        description="Promises are extracted from meetings and email as they happen."
      />
    );
  }

  const ours = detail.commitments.filter((c) => c.direction === 'we_owe');
  const theirs = detail.commitments.filter((c) => c.direction === 'they_owe');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>We owe · {ours.length}</CardTitle>
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
          <CardTitle>They owe · {theirs.length}</CardTitle>
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

function Objections({ objections }: { objections: Detail['objections'] }) {
  if (objections.length === 0) {
    return <EmptyState icon={<NavIcon name="signal" />} title="No objections recorded" />;
  }

  return (
    <ul className="space-y-3">
      {objections.map((objection) => (
        <Card as="li" key={objection.id}>
          <CardBody className="pt-3.5">
            <div className="flex flex-wrap items-center gap-1.5">
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
              <Badge
                tone={
                  objection.status === 'resolved'
                    ? 'success'
                    : objection.status === 'addressed'
                      ? 'info'
                      : objection.status === 'lost_to'
                        ? 'danger'
                        : 'outline'
                }
              >
                {titleCase(objection.status)}
              </Badge>
              <span className="text-2xs text-text-subtle">
                {dayMonth(objection.occurredAt)} · {Math.round(objection.confidence * 100)}% confidence
              </span>
            </div>

            <p className="mt-1.5 text-sm text-text text-pretty">{objection.summary}</p>
            {objection.resolution && (
              <p className="mt-1 text-xs text-success-text text-pretty">
                Resolution: {objection.resolution}
              </p>
            )}

            <EvidenceQuote
              className="mt-2.5"
              quote={objection.sourceQuote}
              source={
                objection.sourceType && objection.sourceId
                  ? {
                      type: objection.sourceType as 'email' | 'transcript' | 'meeting',
                      id: objection.sourceId,
                      label: 'Where this was said',
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

function Stakeholders({ stakeholders }: { stakeholders: Detail['stakeholders'] }) {
  if (stakeholders.length === 0) {
    return <EmptyState icon={<NavIcon name="users" />} title="No contacts on this account" />;
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <Thead>
          <Tr className="hover:bg-transparent">
            <Th>Name</Th>
            <Th>Role in deal</Th>
            <Th>Title</Th>
            <Th align="right">Influence</Th>
            <Th align="right">Last contact</Th>
          </Tr>
        </Thead>
        <Tbody>
          {stakeholders.map((person) => (
            <Tr key={person.id}>
              <Td>
                <Link
                  href={`/contacts/${person.id}`}
                  className="block truncate text-sm font-medium text-text hover:text-accent-text"
                >
                  {person.firstName} {person.lastName}
                </Link>
                {person.email && (
                  <span className="block truncate text-2xs text-text-subtle">{person.email}</span>
                )}
              </Td>
              <Td>
                {person.buyingRole && person.buyingRole !== 'unknown' ? (
                  <Badge
                    tone={
                      person.buyingRole === 'champion'
                        ? 'success'
                        : person.buyingRole === 'blocker'
                          ? 'danger'
                          : person.buyingRole === 'economic_buyer' || person.buyingRole === 'decision_maker'
                            ? 'accent'
                            : 'info'
                    }
                  >
                    {titleCase(person.buyingRole)}
                  </Badge>
                ) : (
                  <span className="text-2xs text-text-subtle">Not identified</span>
                )}
              </Td>
              <Td>
                <span className="text-xs text-text-muted">{person.title ?? '—'}</span>
              </Td>
              <Td align="right">
                <span className="text-xs text-text-muted">{person.influence ?? '—'}</span>
              </Td>
              <Td align="right">
                <span className="text-xs text-text-muted">
                  {relativeTime(person.lastInteractionAt)}
                </span>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}

function Meetings({ meetings }: { meetings: Detail['meetings'] }) {
  if (meetings.length === 0) {
    return <EmptyState icon={<NavIcon name="calendar" />} title="No meetings on this deal" />;
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
              <span className="shrink-0 text-2xs text-text-subtle">{shortDate(meeting.startsAt)}</span>
            </div>
            {meeting.intelligence?.summary && (
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted text-pretty">
                {meeting.intelligence.summary}
              </p>
            )}
            {meeting.intelligence?.nextSteps && meeting.intelligence.nextSteps.length > 0 && (
              <ul className="mt-2 space-y-1">
                {meeting.intelligence.nextSteps.slice(0, 3).map((step, i) => (
                  <li key={i} className="flex gap-2 text-2xs text-text-muted text-pretty">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ))}
    </ul>
  );
}

function Emails({ emails }: { emails: Detail['emails'] }) {
  if (emails.length === 0) {
    return <EmptyState icon={<NavIcon name="inbox" />} title="No email on this deal" />;
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
              <span className="shrink-0 text-2xs text-text-subtle">{shortDate(email.sentAt)}</span>
            </div>
            <p className="mt-1 text-2xs text-text-subtle">{email.fromName ?? email.fromEmail}</p>
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

function TasksList({ tasks }: { tasks: Detail['tasks'] }) {
  if (tasks.length === 0) {
    return <EmptyState icon={<NavIcon name="check" />} title="No tasks on this deal" />;
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <Thead>
          <Tr className="hover:bg-transparent">
            <Th>Task</Th>
            <Th>Status</Th>
            <Th>Priority</Th>
            <Th>Assignee</Th>
            <Th align="right">Due</Th>
          </Tr>
        </Thead>
        <Tbody>
          {tasks.map((task) => (
            <Tr key={task.id}>
              <Td>
                <span className="text-sm text-text">{task.title}</span>
              </Td>
              <Td>
                <Badge tone={task.status === 'completed' ? 'success' : 'outline'}>
                  {titleCase(task.status)}
                </Badge>
              </Td>
              <Td>
                <Badge
                  tone={
                    task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'neutral'
                  }
                >
                  {titleCase(task.priority)}
                </Badge>
              </Td>
              <Td>
                <span className="text-xs text-text-muted">{task.assigneeName ?? 'Unassigned'}</span>
              </Td>
              <Td align="right">
                <span
                  className={
                    task.dueAt && task.dueAt.getTime() < Date.now() && task.status !== 'completed'
                      ? 'text-xs font-medium text-danger-text'
                      : 'text-xs text-text-muted'
                  }
                >
                  {task.dueAt ? relativeTime(task.dueAt) : '—'}
                </span>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}

function Facts({ facts }: { facts: Detail['facts'] }) {
  if (facts.length === 0) {
    return (
      <EmptyState
        icon={<NavIcon name="book" />}
        title="No structured facts yet"
        description="Budgets, timelines, seat counts and decision processes appear here once a customer states them."
      />
    );
  }

  return (
    <Card>
      <CardBody className="pt-4">
        <ul className="space-y-4">
          {facts.map((fact) => (
            <li key={fact.id} className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs font-medium text-text">{fact.label}</p>
                <span className="text-2xs text-text-subtle">
                  since {shortDate(fact.validFrom)} · {Math.round(fact.confidence * 100)}% confidence
                </span>
              </div>
              <p className="mt-0.5 text-sm font-semibold text-text">
                {fact.valueNumber != null
                  ? fact.unit === 'USD'
                    ? money(fact.valueNumber)
                    : `${fact.valueNumber.toLocaleString()}${fact.unit ? ` ${fact.unit}` : ''}`
                  : (fact.valueText ?? '—')}
              </p>
              <EvidenceQuote className="mt-1.5" quote={fact.sourceQuote} />
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
