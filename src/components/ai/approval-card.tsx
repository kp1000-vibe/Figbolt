'use client';

import * as React from 'react';
import type { ApprovalPreview, RiskLevel, SourceRef } from '@/db/schema';
import { Badge, Button, Card, Input, Textarea } from '@/components/ui/primitives';
import { Modal, Spinner, useToast } from '@/components/ui/feedback';
import { CitationList } from './citation';
import { AlertTriangle, Mail, Shield, Sliders } from '@/components/layout/icons';
import { cn, relativeTime, titleCase } from '@/lib/utils';
import { decideApprovalAction } from '@/app/actions';

/**
 * The approval surface.
 *
 * The rule this implements: **the payload that executes is the payload that
 * was shown.** The preview renders the real email body, the real field diff,
 * the real list of affected records — never a paraphrase. Editing produces an
 * `editedPayload` that replaces the original on execution, so what the
 * approver read is what runs.
 */

type Approval = {
  id: string;
  tool: string;
  riskLevel: RiskLevel;
  title: string;
  rationale: string | null;
  preview: ApprovalPreview | null;
  payload: Record<string, unknown>;
  sources: SourceRef[];
  createdAt: string;
  expiresAt: string | null;
};

const RISK_COPY: Record<RiskLevel, { label: string; tone: 'neutral' | 'warning' | 'danger'; why: string }> = {
  low: { label: 'Low risk', tone: 'neutral', why: 'Read-only or internal. Runs without approval by default.' },
  medium: {
    label: 'Medium risk',
    tone: 'warning',
    why: 'Changes CRM data. Held for review because this workspace requires it.',
  },
  high: {
    label: 'High risk',
    tone: 'danger',
    why: 'Externally visible or irreversible. Always requires explicit approval.',
  },
};

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [decided, setDecided] = React.useState<'approved' | 'rejected' | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const { toast } = useToast();

  if (decided) {
    return (
      <Card className={cn('px-4 py-3', decided === 'approved' ? 'border-success/30' : 'border-border')}>
        <p className="text-xs text-text-muted">
          {decided === 'approved' ? 'Approved and executed' : 'Rejected — nothing was actioned'}:{' '}
          <span className="font-medium text-text">{approval.title}</span>
        </p>
      </Card>
    );
  }

  const decide = async (decision: 'approve' | 'reject', editedPayload?: Record<string, unknown>) => {
    setPending(decision);
    const result = await decideApprovalAction({ approvalId: approval.id, decision, editedPayload });
    setPending(null);

    if (result.ok) {
      setDecided(decision === 'approve' ? 'approved' : 'rejected');
      toast({ title: result.message ?? 'Done.', tone: 'success' });
    } else {
      toast({ title: 'Could not complete', description: result.error, tone: 'error' });
    }
  };

  const risk = RISK_COPY[approval.riskLevel];

  return (
    <>
      <Card
        className={cn(
          'overflow-hidden',
          approval.riskLevel === 'high' && 'border-danger/30',
          approval.riskLevel === 'medium' && 'border-warning/30',
        )}
      >
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <span
            className={cn(
              'mt-0.5 shrink-0',
              approval.riskLevel === 'high' ? 'text-danger' : 'text-warning',
            )}
          >
            {approval.tool === 'send_email' ? <Mail className="size-4" /> : <Shield className="size-4" />}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="min-w-0 text-sm font-medium text-text text-pretty">{approval.title}</p>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge tone={risk.tone}>{risk.label}</Badge>
                <span className="text-2xs text-text-subtle">{relativeTime(approval.createdAt)}</span>
              </div>
            </div>

            <p className="mt-1 font-mono text-2xs text-text-subtle">{approval.tool}</p>

            {approval.rationale && (
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted text-pretty">
                {approval.rationale}
              </p>
            )}

            <p className="mt-1.5 text-2xs text-text-subtle text-pretty">{risk.why}</p>

            {approval.expiresAt && (
              <p className="mt-1 text-2xs text-text-subtle">
                Expires {relativeTime(approval.expiresAt)} — it will not run after that.
              </p>
            )}
          </div>
        </div>

        {/* The exact proposed effect. */}
        <div className="mt-3 px-4">
          <PreviewBody preview={approval.preview} payload={approval.payload} />
        </div>

        {approval.sources.length > 0 && (
          <div className="mt-3 border-t border-border bg-bg-subtle px-4 py-2.5">
            <CitationList sources={approval.sources} numbered={false} label="Evidence behind this" />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
          <Button
            variant="primary"
            size="sm"
            onClick={() => decide('approve')}
            disabled={pending !== null}
          >
            {pending === 'approve' && <Spinner className="size-3" />}
            Approve &amp; run
          </Button>

          {approval.preview?.kind === 'email' && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={pending !== null}>
              <Sliders />
              Edit first
            </Button>
          )}

          <Button
            variant="outlineDanger"
            size="sm"
            onClick={() => decide('reject')}
            disabled={pending !== null}
          >
            {pending === 'reject' && <Spinner className="size-3" />}
            Discard
          </Button>

          <p className="ml-auto text-2xs text-text-subtle">
            Nothing happens until you choose.
          </p>
        </div>
      </Card>

      {editing && approval.preview?.kind === 'email' && (
        <EditEmailModal
          preview={approval.preview}
          payload={approval.payload}
          onClose={() => setEditing(false)}
          onSubmit={(edited) => {
            setEditing(false);
            void decide('approve', edited);
          }}
        />
      )}
    </>
  );
}

function PreviewBody({
  preview,
  payload,
}: {
  preview: ApprovalPreview | null;
  payload: Record<string, unknown>;
}) {
  if (!preview) {
    return (
      <pre className="max-h-56 overflow-auto rounded-[var(--radius-md)] bg-bg-subtle px-3 py-2 font-mono text-2xs text-text-muted">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }

  if (preview.kind === 'email') {
    return (
      <div className="rounded-[var(--radius-md)] border border-border bg-bg-subtle">
        <dl className="space-y-1 border-b border-border px-3 py-2 text-2xs">
          <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-text-subtle">To</dt>
            <dd className="min-w-0 break-words text-text">{preview.to.join(', ')}</dd>
          </div>
          {preview.cc && preview.cc.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-12 shrink-0 text-text-subtle">Cc</dt>
              <dd className="min-w-0 break-words text-text">{preview.cc.join(', ')}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-12 shrink-0 text-text-subtle">Subject</dt>
            <dd className="min-w-0 break-words font-medium text-text">{preview.subject}</dd>
          </div>
        </dl>
        <pre className="max-h-72 overflow-auto px-3 py-2.5 font-sans text-xs leading-relaxed whitespace-pre-wrap text-text">
          {preview.body}
        </pre>
      </div>
    );
  }

  if (preview.kind === 'record_diff') {
    return (
      <div className="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2.5">
        <p className="text-2xs text-text-subtle">
          {titleCase(preview.recordType)} · {preview.recordLabel}
        </p>
        <ul className="mt-2 space-y-1.5">
          {preview.changes.map((change) => (
            <li key={change.field} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="shrink-0 font-medium text-text">{change.label}</span>
              <span className="rounded bg-danger-subtle px-1.5 py-0.5 font-mono text-2xs text-danger-text line-through">
                {formatValue(change.from)}
              </span>
              <span className="text-text-subtle">→</span>
              <span className="rounded bg-success-subtle px-1.5 py-0.5 font-mono text-2xs text-success-text">
                {formatValue(change.to)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (preview.kind === 'bulk') {
    return (
      <div className="rounded-[var(--radius-md)] border border-danger/25 bg-danger-subtle px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-danger-text">
          <AlertTriangle className="size-3.5" />
          {preview.itemCount} records will change
        </p>
        <p className="mt-1 text-2xs text-danger-text/85 text-pretty">{preview.description}</p>
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {preview.items.map((item, i) => (
            <li key={i} className="text-2xs text-danger-text/90">
              <span className="font-medium">{item.label}</span>
              {item.detail && <span className="text-danger-text/70"> — {item.detail}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <pre className="max-h-56 overflow-auto rounded-[var(--radius-md)] bg-bg-subtle px-3 py-2 font-sans text-xs leading-relaxed whitespace-pre-wrap text-text">
      {preview.body}
    </pre>
  );
}

function EditEmailModal({
  preview,
  payload,
  onClose,
  onSubmit,
}: {
  preview: Extract<ApprovalPreview, { kind: 'email' }>;
  payload: Record<string, unknown>;
  onClose: () => void;
  onSubmit: (edited: Record<string, unknown>) => void;
}) {
  const [to, setTo] = React.useState(preview.to.join(', '));
  const [subject, setSubject] = React.useState(preview.subject);
  const [body, setBody] = React.useState(preview.body);

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit before sending"
      description="Your edits replace the proposal. The version you approve is exactly what goes out."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              onSubmit({
                ...payload,
                to: to.split(/\s*,\s*/).filter(Boolean),
                subject,
                body,
              })
            }
            disabled={!subject.trim() || body.trim().length < 10}
          >
            Approve &amp; send edited
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">To</label>
          <Input value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">Subject</label>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">Body</label>
          <Textarea
            rows={16}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="font-mono text-xs leading-relaxed"
          />
        </div>
      </div>
    </Modal>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return value.toLocaleString();
  const s = String(value);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
