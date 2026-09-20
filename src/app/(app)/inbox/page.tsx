import { requireCtx } from '@/server/context';
import { INBOX_SECTIONS, inboxCounts, listInbox } from '@/server/inbox';
import { listPendingApprovals } from '@/server/approvals';
import { PageShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/primitives';
import { InboxView } from './inbox-view';

export const metadata = { title: 'Inbox' };

/**
 * The unified AI inbox.
 *
 * Approvals are fetched alongside notifications rather than being one more
 * notification kind, because they need a different surface: an approval must
 * render the exact proposed payload and offer approve / edit / reject, not a
 * "recommended action".
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const params = await searchParams;
  const ctx = await requireCtx();

  const [items, counts, approvals] = await Promise.all([
    listInbox(ctx, { limit: 200 }),
    inboxCounts(ctx),
    listPendingApprovals(ctx, 50),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Inbox"
        description="Everything that needs a decision, with what happened, why it matters, and what to do about it."
      />

      <div className="mt-5">
        <InboxView
          items={items.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            whatHappened: item.whatHappened,
            whyItMatters: item.whyItMatters,
            recommendedAction: item.recommendedAction,
            severity: item.severity,
            accountId: item.accountId,
            accountName: item.accountName,
            opportunityId: item.opportunityId,
            opportunityName: item.opportunityName,
            contactId: item.contactId,
            createdAt: item.createdAt.toISOString(),
          }))}
          approvals={approvals.map((approval) => ({
            id: approval.id,
            tool: approval.tool,
            riskLevel: approval.riskLevel,
            title: approval.title,
            rationale: approval.rationale,
            preview: approval.preview,
            payload: approval.payload,
            sources: approval.sources,
            createdAt: approval.createdAt.toISOString(),
            expiresAt: approval.expiresAt?.toISOString() ?? null,
          }))}
          counts={counts}
          sections={INBOX_SECTIONS}
          initialSection={params.section}
        />
      </div>
    </PageShell>
  );
}
