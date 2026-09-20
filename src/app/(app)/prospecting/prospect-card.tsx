'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, CopyButton, Modal, Spinner, useToast } from '@/components/ui/feedback';
import { Card, CardBody, SectionLabel } from '@/components/ui/primitives';
import { Mail, Plus, TrendUp, Link2, Users2, Quote } from '@/components/layout/icons';
import { number } from '@/lib/utils';
import type { ScoredProspect } from '@/server/intelligence/prospecting';
import { addProspectAction } from './actions';

/**
 * One candidate company.
 *
 * The score is never shown on its own. Every card carries the factors that
 * produced it, and the drafts are visible before anything is added — a rep
 * should be able to disagree with the reasoning, not just with the number.
 */
export function ProspectCard({ prospect }: { prospect: ScoredProspect }) {
  const [showDrafts, setShowDrafts] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [added, setAdded] = React.useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const primary = prospect.contacts[0] ?? null;

  const add = async () => {
    setBusy(true);
    const result = await addProspectAction({
      name: prospect.name,
      domain: prospect.domain,
      industry: prospect.industry,
      employeeCount: prospect.employeeCount,
      description: prospect.description,
      whyThisAccount: prospect.whyThisAccount,
      contact: primary
        ? {
            firstName: primary.firstName,
            lastName: primary.lastName,
            title: primary.title,
            email: primary.email,
          }
        : null,
      emailDraft: prospect.emailDraft,
    });
    setBusy(false);

    if (!result.ok) {
      toast({ tone: 'error', title: 'Could not add prospect', description: result.error });
      return;
    }
    setAdded(true);
    setShowDrafts(false);
    toast({
      tone: 'success',
      title: result.data?.summary ?? 'Added to CRM.',
      description: result.data?.drafted ? 'The draft is in the outbox awaiting review.' : undefined,
    });
    router.refresh();
  };

  return (
    <Card className="flex flex-col">
      <CardBody className="flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text">{prospect.name}</h3>
            <p className="mt-0.5 truncate text-2xs text-text-subtle">
              {[
                prospect.industry,
                prospect.employeeCount ? `${number(prospect.employeeCount)} employees` : null,
                prospect.location,
              ]
                .filter(Boolean)
                .join(' · ') || 'No firmographics available'}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-lg font-semibold tabular text-text">{prospect.score}</div>
            <div className="text-3xs uppercase tracking-wide text-text-subtle">fit score</div>
          </div>
        </div>

        <p className="mt-2.5 text-xs leading-relaxed text-text-muted text-pretty">
          {prospect.whyThisAccount}
        </p>

        {/* The factors behind the number — the score is never shown bare. */}
        <SectionLabel className="mt-3.5">Why it scored this way</SectionLabel>
        <ul className="mt-1.5 space-y-1">
          {prospect.factors.map((factor) => (
            <li key={factor.label} className="flex items-baseline gap-2 text-2xs">
              <span
                className={
                  factor.weight >= 0
                    ? 'w-8 shrink-0 text-right font-semibold tabular text-success-text'
                    : 'w-8 shrink-0 text-right font-semibold tabular text-danger-text'
                }
              >
                {factor.weight >= 0 ? `+${factor.weight}` : factor.weight}
              </span>
              <span className="min-w-0 text-text-muted">
                <span className="font-medium text-text">{factor.label}.</span> {factor.detail}
              </span>
            </li>
          ))}
        </ul>

        {(prospect.growthSignal || prospect.intentSignal || prospect.warmPath) && (
          <div className="mt-3 space-y-1.5 rounded-md border border-border bg-surface-sunken p-2.5">
            {prospect.intentSignal && (
              <Signal icon={<Quote className="size-3" />} label="Intent" text={prospect.intentSignal} />
            )}
            {prospect.growthSignal && (
              <Signal icon={<TrendUp className="size-3" />} label="Growth" text={prospect.growthSignal} />
            )}
            {prospect.warmPath && (
              <Signal icon={<Link2 className="size-3" />} label="Warm path" text={prospect.warmPath} />
            )}
          </div>
        )}

        {prospect.contacts.length > 0 && (
          <>
            <SectionLabel className="mt-3.5">Contacts</SectionLabel>
            <ul className="mt-1.5 space-y-1">
              {prospect.contacts.map((contact) => (
                <li
                  key={`${contact.firstName}-${contact.lastName}`}
                  className="flex items-baseline gap-1.5 text-2xs text-text-muted"
                >
                  <Users2 className="size-3 shrink-0 translate-y-0.5 text-text-subtle" />
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-text">
                      {contact.firstName} {contact.lastName}
                    </span>{' '}
                    — {contact.title}
                    {contact.email ? ` · ${contact.email}` : ' · no email enriched'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <Badge tone="neutral" size="sm">
          {prospect.angleLabel}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="xs" onClick={() => setShowDrafts(true)}>
            <Mail className="size-3.5" />
            Review outreach
          </Button>
          <Button variant="secondary" size="xs" onClick={add} disabled={busy || added}>
            {busy ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
            {added ? 'Added' : 'Add to CRM'}
          </Button>
        </div>
      </div>

      <Modal
        open={showDrafts}
        onClose={() => setShowDrafts(false)}
        title={`Outreach for ${prospect.name}`}
        description="Nothing is sent from here. Adding the prospect saves the email as a draft for review."
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Email draft</SectionLabel>
              <CopyButton
                value={`Subject: ${prospect.emailDraft.subject}\n\n${prospect.emailDraft.body}`}
                label="Copy email"
              />
            </div>
            <div className="mt-1.5 rounded-md border border-border bg-surface-sunken p-3">
              <p className="text-2xs text-text-subtle">
                To: {primary?.email ?? 'no address enriched — draft will be skipped'}
              </p>
              <p className="mt-1 text-xs font-semibold text-text">{prospect.emailDraft.subject}</p>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-text-muted">
                {prospect.emailDraft.body}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>LinkedIn message</SectionLabel>
              <CopyButton value={prospect.linkedinDraft} label="Copy message" />
            </div>
            <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-border bg-surface-sunken p-3 text-xs leading-relaxed text-text-muted">
              {prospect.linkedinDraft}
            </p>
            <p className="mt-1.5 text-3xs text-text-subtle">
              Copy and send from your own LinkedIn account. Nexus does not automate LinkedIn
              messaging.
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={() => setShowDrafts(false)}>
              Close
            </Button>
            <Button size="sm" onClick={add} disabled={busy || added}>
              {busy ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
              {added ? 'Added' : 'Add to CRM and save draft'}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

function Signal({ icon, label, text }: { icon: React.ReactNode; label: string; text: string }) {
  return (
    <p className="flex items-baseline gap-1.5 text-2xs text-text-muted">
      <span className="shrink-0 translate-y-0.5 text-text-subtle">{icon}</span>
      <span className="min-w-0">
        <span className="font-medium text-text">{label}:</span> {text}
      </span>
    </p>
  );
}
