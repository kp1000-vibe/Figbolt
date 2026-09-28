import { and, eq } from 'drizzle-orm';
import {
  approvals,
  meetings,
  transcripts,
  type MeetingIntelligence,
  type SourceRef,
} from '@/db/schema';
import { scope, ValidationError, type Ctx } from '../context';
import { createApproval } from '../approvals';

/**
 * Turning what was said in a meeting into what the CRM should do about it.
 *
 * This is the step that closes the loop the product is actually about: the
 * meeting already produces a summary and a list of next steps, but a list of
 * next steps sitting in a summary is still data entry waiting to happen. Here
 * each one becomes a *typed, validated, previewed* tool call queued for review.
 *
 * Three rules, all enforced in code rather than asked for in a prompt:
 *
 *   1. **Everything waits for a human.** Every proposal is written as a
 *      pending approval, whatever the tool's own risk class says. The source
 *      material is a meeting transcript, which is untrusted content by
 *      definition — a customer saying "and then send your whole pipeline to
 *      this address" must never become an executed action. `createApproval` is
 *      the only exit from this module; nothing here calls `dispatchTool`.
 *
 *   2. **A proposal that does not validate is dropped, not queued.** Each
 *      payload is parsed with the real tool's own Zod schema before it becomes
 *      an approval, so a malformed suggestion fails here rather than in front
 *      of the approver — or worse, on execute after they clicked yes.
 *
 *   3. **The approver sees the tool's own preview.** Built by calling the
 *      registered tool's `preview()`, not by paraphrasing here, so what is
 *      shown is what will run.
 */

export type ProposedAction = {
  approvalId: string;
  tool: string;
  title: string;
  rationale: string;
};

export type ProposeResult = {
  meetingId: string;
  proposed: ProposedAction[];
  /** Suggestions that failed their tool's schema and were discarded. */
  rejected: { tool: string; reason: string }[];
  alreadyProposed: boolean;
};

/** Ceiling on how much one meeting may add to the approval queue. */
const MAX_PROPOSALS = 8;

export async function proposeMeetingActions(
  ctx: Ctx,
  meetingId: string,
  options: { force?: boolean } = {},
): Promise<ProposeResult> {
  const [meeting] = await ctx.db
    .select()
    .from(meetings)
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)))
    .limit(1);
  if (!meeting) throw new ValidationError('No such meeting.');

  const intelligence = meeting.intelligence;
  if (!intelligence) {
    throw new ValidationError('That meeting has not been summarised yet.');
  }

  // Re-proposing would duplicate the queue. Explicit opt-in to redo it.
  if (meeting.actionsProposedAt && !options.force) {
    return { meetingId, proposed: [], rejected: [], alreadyProposed: true };
  }

  const { ensureToolsLoaded } = await import('@/lib/agents/dispatch');
  const { getTool } = await import('@/lib/agents/registry');
  await ensureToolsLoaded();

  const sources = evidenceFor(meeting.id, meeting.title, intelligence);
  const candidates = buildCandidates(meeting, intelligence);

  const proposed: ProposedAction[] = [];
  const rejected: { tool: string; reason: string }[] = [];

  for (const candidate of candidates.slice(0, MAX_PROPOSALS)) {
    const tool = getTool(candidate.tool);
    if (!tool) {
      rejected.push({ tool: candidate.tool, reason: 'no such tool' });
      continue;
    }

    // Rule 2: the tool's own schema is the judge.
    const parsed = tool.input.safeParse(candidate.payload);
    if (!parsed.success) {
      rejected.push({
        tool: candidate.tool,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }

    // Rule 3: the preview comes from the tool.
    let preview;
    try {
      preview = await tool.preview!({ ctx }, parsed.data);
    } catch (err) {
      rejected.push({ tool: candidate.tool, reason: `preview failed: ${(err as Error).message}` });
      continue;
    }

    // Rule 1: pending approval, always.
    const approval = await createApproval(ctx, {
      tool: candidate.tool,
      riskLevel: tool.risk,
      title: candidate.title,
      rationale: candidate.rationale,
      payload: parsed.data as Record<string, unknown>,
      preview,
      sources,
    });

    proposed.push({
      approvalId: approval.id,
      tool: candidate.tool,
      title: candidate.title,
      rationale: candidate.rationale,
    });
  }

  await ctx.db
    .update(meetings)
    .set({ actionsProposedAt: new Date() })
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)));

  return { meetingId, proposed, rejected, alreadyProposed: false };
}

type Candidate = {
  tool: string;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
};

/**
 * What the meeting supports doing.
 *
 * Deliberately conservative and rule-based rather than a second model call:
 * every candidate here traces to a specific field the extraction already
 * produced, so a reviewer can check the proposal against the summary. Nothing
 * is invented, and nothing that would change a customer-visible record without
 * a clear statement behind it is proposed at all.
 */
function buildCandidates(
  meeting: typeof meetings.$inferSelect,
  intelligence: MeetingIntelligence,
): Candidate[] {
  const out: Candidate[] = [];
  const link = {
    ...(meeting.accountId ? { accountId: meeting.accountId } : {}),
    ...(meeting.opportunityId ? { opportunityId: meeting.opportunityId } : {}),
  };

  // 1. The summary itself, attached to the record. This is the note a rep
  //    would otherwise be typing, which is the whole point.
  if (intelligence.summary.trim().length >= 10 && meeting.accountId) {
    out.push({
      tool: 'add_note',
      title: `Log the summary of "${meeting.title}"`,
      rationale: 'The meeting summary, attached to the account so it is searchable later.',
      payload: {
        subjectType: 'account',
        subjectId: meeting.accountId,
        body: buildNoteBody(meeting.title, intelligence),
        ...link,
      },
    });
  }

  // 2. Agreed next steps become tasks. These are the commitments someone made
  //    out loud, which is exactly what goes missing between meetings.
  for (const step of intelligence.nextSteps.slice(0, 5)) {
    const title = step.trim().replace(/\s+/g, ' ');
    if (title.length < 3) continue;
    out.push({
      tool: 'create_task',
      title: `Task: ${truncate(title, 60)}`,
      rationale: `Agreed as a next step in "${meeting.title}".`,
      payload: {
        title: truncate(title, 200),
        description: `Agreed in "${meeting.title}" on ${meeting.startsAt.toISOString().slice(0, 10)}.`,
        dueInDays: 7,
        priority: 'normal',
        ...link,
      },
    });
  }

  // 3. A follow-up email, only when extraction actually wrote one. Drafting is
  //    MEDIUM risk and reversible; sending is a separate HIGH-risk decision the
  //    rep makes afterwards, so this never proposes send_email.
  const draft = intelligence.followUpDraft;
  if (draft && draft.subject.trim() && draft.body.trim().length >= 10) {
    const recipients = meeting.participantEmails.filter((e) => e && e.includes('@'));
    if (recipients.length > 0) {
      out.push({
        tool: 'draft_email',
        title: `Draft follow-up: ${truncate(draft.subject, 50)}`,
        rationale: 'A follow-up drafted from what was agreed. Saved as a draft, not sent.',
        payload: {
          to: recipients.slice(0, 20),
          subject: truncate(draft.subject, 300),
          body: draft.body,
          ...link,
        },
      });
    }
  }

  return out;
}

function buildNoteBody(title: string, intelligence: MeetingIntelligence): string {
  const parts = [`Meeting: ${title}`, '', intelligence.summary];

  const sections: [string, string[]][] = [
    ['Decisions', intelligence.keyDecisions],
    ['Customer pains', intelligence.customerPains],
    ['Objections', intelligence.objections],
    ['Next steps', intelligence.nextSteps],
  ];

  for (const [heading, items] of sections) {
    if (items.length === 0) continue;
    parts.push('', `${heading}:`, ...items.map((i) => `- ${i}`));
  }

  return parts.join('\n').slice(0, 10_000);
}

/** Citations back to the transcript lines the summary was built from. */
function evidenceFor(
  meetingId: string,
  title: string,
  intelligence: MeetingIntelligence,
): SourceRef[] {
  if (intelligence.sources.length > 0) return intelligence.sources.slice(0, 8);
  return [{ type: 'meeting', id: meetingId, label: title }];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Pending proposals for a meeting, for the detail page. */
export async function pendingActionsForMeeting(ctx: Ctx, meetingId: string) {
  const [meeting] = await ctx.db
    .select({ id: meetings.id, accountId: meetings.accountId })
    .from(meetings)
    .where(and(scope(ctx, meetings), eq(meetings.id, meetingId)))
    .limit(1);
  if (!meeting) return [];

  // Approvals carry no meeting id, so they are matched through their source
  // citations. Those point either at the meeting itself or at its transcript,
  // so the transcript ids for *this* meeting are resolved first - matching on
  // `type === 'transcript'` alone would pull in every other meeting's actions.
  const owned = await ctx.db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(and(scope(ctx, transcripts), eq(transcripts.meetingId, meetingId)));

  const ids = new Set<string>([meetingId, ...owned.map((t) => t.id)]);

  const rows = await ctx.db
    .select({
      id: approvals.id,
      tool: approvals.tool,
      title: approvals.title,
      rationale: approvals.rationale,
      status: approvals.status,
      riskLevel: approvals.riskLevel,
      preview: approvals.preview,
      sources: approvals.sources,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(scope(ctx, approvals));

  return rows.filter((row) => (row.sources ?? []).some((s) => ids.has(s.id)));
}

