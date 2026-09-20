'use client';

import * as React from 'react';
import type { CompanyContext } from '@/db/schema';
import { Button, Field, Input, Textarea } from '@/components/ui/primitives';
import { Spinner, useToast } from '@/components/ui/feedback';
import { saveCompanyContextAction } from './actions';

/**
 * The onboarding questionnaire, editable forever.
 *
 * These answers become trusted workspace context in every prompt, so they are
 * the highest-leverage text in the product: they are what stop an answer from
 * sounding like it was written about a generic SaaS company.
 */

const FIELDS: {
  key: keyof CompanyContext;
  label: string;
  hint: string;
  kind: 'text' | 'long' | 'list';
  placeholder: string;
}[] = [
  {
    key: 'whatWeSell',
    label: 'What does your company sell?',
    hint: 'In the words a customer would recognise, not marketing copy.',
    kind: 'long',
    placeholder: 'An operations workflow platform that replaces spreadsheet-and-email processes…',
  },
  {
    key: 'idealCustomer',
    label: 'Who is your ideal customer?',
    hint: 'Size, team shape, and the situation that makes them a fit.',
    kind: 'long',
    placeholder: 'Companies of 200–5,000 employees with a dedicated operations team…',
  },
  {
    key: 'targetIndustries',
    label: 'Industries you target',
    hint: 'Comma-separated.',
    kind: 'list',
    placeholder: 'Financial Services, Healthcare, Logistics',
  },
  {
    key: 'qualificationCriteria',
    label: 'What counts as a qualified opportunity?',
    hint: 'Used by deal health and by agents deciding what to flag.',
    kind: 'long',
    placeholder: 'A named operations owner feels real pain, 50+ seats in scope, a budget holder identified…',
  },
  {
    key: 'salesProcess',
    label: 'Describe your sales process',
    hint: 'Stages and what has to be true at each one.',
    kind: 'long',
    placeholder: 'Discovery → Evaluation → Proposal → Negotiation. Enterprise adds a security review…',
  },
  {
    key: 'commonObjections',
    label: 'Common objections',
    hint: 'One per line.',
    kind: 'list',
    placeholder: 'Security review required before procurement\nPer-seat pricing at large headcount',
  },
  {
    key: 'competitors',
    label: 'Competitors',
    hint: 'Comma-separated. Used to detect mentions in conversations.',
    kind: 'list',
    placeholder: 'Vantage Systems, Coreflow, Tessellate',
  },
  {
    key: 'differentiators',
    label: 'What makes you different?',
    hint: 'The thing that actually wins deals, not a feature list.',
    kind: 'long',
    placeholder: 'Full audit trail by default, no data migration, configurable by ops without engineering…',
  },
];

export function CompanyContextForm({
  initial,
  canEdit,
}: {
  initial: CompanyContext;
  canEdit: boolean;
}) {
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const field of FIELDS) {
      const value = initial[field.key];
      out[field.key] = Array.isArray(value) ? value.join(field.key === 'commonObjections' ? '\n' : ', ') : (value ?? '');
    }
    return out;
  });
  const [pending, setPending] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const { toast } = useToast();

  const set = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const submit = async () => {
    setPending(true);
    const result = await saveCompanyContextAction({
      whatWeSell: values['whatWeSell'] || undefined,
      idealCustomer: values['idealCustomer'] || undefined,
      targetIndustries: splitList(values['targetIndustries'] ?? '', ','),
      qualificationCriteria: values['qualificationCriteria'] || undefined,
      salesProcess: values['salesProcess'] || undefined,
      commonObjections: splitList(values['commonObjections'] ?? '', '\n'),
      competitors: splitList(values['competitors'] ?? '', ','),
      differentiators: values['differentiators'] || undefined,
    });
    setPending(false);

    if (result.ok) {
      setDirty(false);
      toast({ title: result.message ?? 'Saved.', tone: 'success' });
    } else {
      toast({ title: 'Could not save', description: result.error, tone: 'error' });
    }
  };

  const filled = FIELDS.filter((f) => (values[f.key] ?? '').trim().length > 0).length;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-muted">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${(filled / FIELDS.length) * 100}%` }}
          />
        </div>
        <span className="shrink-0 text-2xs text-text-subtle">
          {filled}/{FIELDS.length} answered
        </span>
      </div>

      <div className="space-y-4">
        {FIELDS.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            {field.kind === 'long' || field.kind === 'list' ? (
              <Textarea
                rows={field.kind === 'list' ? 2 : 3}
                value={values[field.key] ?? ''}
                onChange={(e) => set(field.key, e.target.value)}
                placeholder={field.placeholder}
                disabled={!canEdit}
                className="text-xs leading-relaxed"
              />
            ) : (
              <Input
                value={values[field.key] ?? ''}
                onChange={(e) => set(field.key, e.target.value)}
                placeholder={field.placeholder}
                disabled={!canEdit}
              />
            )}
          </Field>
        ))}
      </div>

      {canEdit ? (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" size="md" onClick={submit} disabled={pending || !dirty}>
            {pending && <Spinner className="size-4" />}
            Save context
          </Button>
          {dirty && <span className="text-2xs text-text-subtle">Unsaved changes</span>}
        </div>
      ) : (
        <p className="mt-4 text-2xs text-text-subtle">
          You need the workspace:manage permission to edit this.
        </p>
      )}
    </div>
  );
}

function splitList(value: string, separator: string): string[] {
  return value
    .split(separator === '\n' ? /\n+/ : /\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
