import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { evalCases, feedbackSignals } from '@/db/schema';
import { extractDefects, type Utterance } from '@/lib/ai/local/extract';
import { recordSignal, taskForTool, signalSummary } from '@/server/learning/signals';
import { promoteSignals } from '@/server/learning/promote';
import { bootstrapEvalCases } from '@/server/learning/bootstrap';
import { runEvaluation } from '@/server/learning/evaluate';
import { proposeImprovements, raiseProposals, openProposals } from '@/server/learning/propose';
import { createHarness, type Harness } from './harness';

/**
 * The learning loop.
 *
 * Two things are being protected here. First, that the loop actually closes:
 * a rejection becomes a case, the case is replayed, a failure cluster becomes
 * a proposal. Second — and more important — that a proposal is only ever a
 * *proposal*. If this suite ever shows the loop mutating engine behaviour on
 * its own, that is the bug.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

const customer = (text: string): Utterance[] => [{ text, isCustomer: true, index: 0 }];

describe('defect detection', () => {
  it('classifies a timeout as a bug — the gap the loop found', () => {
    // Before this detector existed the offline engine could not produce the
    // `bug` category at all, so every defect in a support ticket was dropped
    // and the "Bug reported" timeline branch was unreachable.
    const found = extractDefects(
      customer('When I try to export the full deviation log the request runs for ninety seconds and then returns a gateway error.'),
    );
    expect(found[0]?.category).toBe('bug');
    expect(found[0]?.title).toBe('Export failure');
    expect(found[0]?.urgency).toBe('blocking');
  });

  it('separates workflow friction from a defect', () => {
    const found = extractDefects(
      customer('They end up calling the regional office instead, which defeats the purpose of rolling it out to stores.'),
    );
    expect(found[0]?.category).toBe('workflow_pain');
  });

  it('names the broken subsystem so two bugs do not collapse', () => {
    const sync = extractDefects(customer('Our nightly Salesforce sync has been failing silently since the 14th.'));
    const notify = extractDefects(customer('Approval notifications are going to the wrong owner every time.'));
    expect(sync[0]?.title).toBe('Sync failure');
    expect(notify[0]?.title).toBe('Notification defect');
    expect(sync[0]?.title).not.toBe(notify[0]?.title);
  });

  it('ignores our own outbound apology about a bug', () => {
    // Otherwise every support reply we send becomes a customer bug report.
    const found = extractDefects([
      { text: 'Sorry about that — the export was broken and we have shipped a fix.', isCustomer: false, index: 0 },
    ]);
    expect(found).toHaveLength(0);
  });

  it('does not fire on ordinary conversation', () => {
    for (const line of [
      'Thanks for making time today, I appreciate you walking me through the rollout.',
      'We are onboarding two more campuses in October and want staff provisioned automatically.',
      'I will approve the budget on my side, we do not need to involve the board.',
    ]) {
      expect(extractDefects(customer(line)), line).toHaveLength(0);
    }
  });
});

describe('capture', () => {
  it('maps a tool to the capability it exercises, not the tool name', () => {
    expect(taskForTool('draft_email')).toBe('draft_email');
    expect(taskForTool('send_email')).toBe('draft_email');
    expect(taskForTool('create_task')).toBe('tool_choice');
    expect(taskForTool('get_account')).toBeNull();
  });

  it('records a rejection as a negative label', async () => {
    const ctx = h.ctxFor('owner');
    const id = await recordSignal(ctx, {
      kind: 'approval_decision',
      task: 'extract_objections',
      verdict: 'negative',
      inputText: 'Please send over the SOC 2 report and the subprocessor list when you get a chance.',
      note: 'not an objection',
    });
    expect(id).toBeTruthy();

    const [row] = await ctx.db.select().from(feedbackSignals).where(eq(feedbackSignals.id, id!));
    expect(row!.verdict).toBe('negative');
    expect(row!.workspaceId).toBe(ctx.workspaceId);
  });

  it('never fails the action it is learning from', async () => {
    // A broken signal write must not propagate: the user's approval already
    // happened and must not be rolled back because bookkeeping failed.
    const broken = { ...h.ctxFor('owner'), workspaceId: 'ws_does_not_exist' };
    await expect(
      recordSignal(broken, {
        kind: 'approval_decision',
        task: 'draft_email',
        verdict: 'positive',
        inputText: 'A body long enough to be considered replayable by the promoter.',
      }),
    ).resolves.toBeNull();
  });
});

describe('promotion', () => {
  it('turns a rejection into a case asserting the engine finds nothing', async () => {
    const ctx = h.ctxFor('owner');
    await recordSignal(ctx, {
      kind: 'approval_decision',
      task: 'extract_objections',
      verdict: 'negative',
      inputText: 'Could you also attach the penetration test summary for the security file?',
    });

    const result = await promoteSignals(ctx);
    expect(result.created).toBeGreaterThan(0);

    const cases = await ctx.db
      .select()
      .from(evalCases)
      .where(eq(evalCases.task, 'extract_objections'));
    const negative = cases.find((c) => c.grader === 'empty');
    expect(negative).toBeDefined();
    expect(negative!.origin).toBe('usage');
  });

  it('declines signals with no replayable input', async () => {
    const ctx = h.ctxFor('owner');
    await recordSignal(ctx, {
      kind: 'answer_rating',
      task: 'answer_question',
      verdict: 'negative',
      inputText: 'too short',
    });
    const before = await promoteSignals(ctx);
    // Nothing promotable: a rating with no replayable input is a mood.
    expect(before.created).toBe(0);
  });
});

describe('scoring', () => {
  it('replays the bootstrapped corpus against the live engine', async () => {
    const ctx = h.ctxFor('owner');
    const boot = await bootstrapEvalCases(ctx);
    expect(boot.created).toBeGreaterThan(0);

    const summary = await runEvaluation(ctx, { trigger: 'ci' });
    expect(summary.total).toBeGreaterThanOrEqual(boot.created);
    // The corpus is every behaviour we have deliberately fixed, so a healthy
    // engine should clear nearly all of it.
    expect(summary.passed / summary.total).toBeGreaterThan(0.8);
  }, 60_000);

  it('is idempotent — bootstrapping twice adds nothing', async () => {
    const ctx = h.ctxFor('owner');
    const second = await bootstrapEvalCases(ctx);
    expect(second.created).toBe(0);
    expect(second.existing).toBeGreaterThan(0);
  });
});

describe('proposals stay proposals', () => {
  it('needs a cluster, not a single failure, before proposing anything', async () => {
    const ctx = h.ctxFor('owner');

    // One impossible case: a real failure, but not yet a pattern.
    await ctx.db.insert(evalCases).values({
      workspaceId: ctx.workspaceId,
      task: 'extract_objections',
      inputText: 'A perfectly ordinary sentence that contains no objection whatsoever, truly.',
      inputMeta: { isCustomer: true },
      expected: { category: 'price' },
      grader: 'category',
      origin: 'authored',
      label: 'single impossible case',
    });

    const summary = await runEvaluation(ctx, { trigger: 'ci' });
    expect(summary.failed).toBeGreaterThan(0);

    const drafts = await proposeImprovements(ctx, summary.runId);
    const forObjections = drafts.filter((d) => d.task === 'extract_objections');
    expect(forObjections).toHaveLength(0);
  }, 60_000);

  it('proposes a narrowing change when the engine over-fires repeatedly', async () => {
    const ctx = h.ctxFor('owner');

    // Three inputs a human would call clean, which the objection extractor
    // does fire on — a genuine over-firing cluster.
    for (const text of [
      'Our security team needs the SOC 2 Type II report before procurement can open a file.',
      'The security review is a hard requirement and that process is not fast at all.',
      'We also need the security questionnaire completed before legal will look at this.',
    ]) {
      await ctx.db.insert(evalCases).values({
        workspaceId: ctx.workspaceId,
        task: 'extract_objections',
        inputText: text,
        inputMeta: { isCustomer: true },
        expected: {},
        grader: 'empty',
        origin: 'authored',
        label: `over-fire probe: ${text.slice(0, 30)}`,
      });
    }

    const summary = await runEvaluation(ctx, { trigger: 'ci' });
    const drafts = await proposeImprovements(ctx, summary.runId);
    const narrowing = drafts.find(
      (d) => d.task === 'extract_objections' && d.change['direction'] === 'narrow',
    );

    expect(narrowing).toBeDefined();
    expect(narrowing!.failingCaseIds.length).toBeGreaterThanOrEqual(2);
    // The proposal must name a real place a human can go and look.
    expect(narrowing!.target).toContain('extract.ts');
    // And it must describe the change, never carry executable code.
    expect(JSON.stringify(narrowing!.change)).not.toMatch(/=>|function\s|\beval\(/);

    const raised = await raiseProposals(ctx, summary.runId, [narrowing!]);
    expect(raised.created).toBe(1);

    const open = await openProposals(ctx);
    const stored = open.find((p) => p.id === raised.proposalIds[0]);
    expect(stored!.status).toBe('proposed');
  }, 60_000);

  it('re-raising the same finding updates rather than duplicating', async () => {
    const ctx = h.ctxFor('owner');
    const summary = await runEvaluation(ctx, { trigger: 'ci' });
    const drafts = await proposeImprovements(ctx, summary.runId);
    const before = (await openProposals(ctx)).length;
    await raiseProposals(ctx, summary.runId, drafts);
    const after = (await openProposals(ctx)).length;
    expect(after).toBe(before);
  }, 60_000);
});

describe('calibration', () => {
  it('summarises signals by task and verdict for the dashboard', async () => {
    const ctx = h.ctxFor('owner');
    const summary = await signalSummary(ctx);
    expect(Array.isArray(summary)).toBe(true);
    expect(summary.some((s) => s.task === 'extract_objections')).toBe(true);
  });
});
