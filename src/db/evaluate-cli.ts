import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from './schema';

/**
 * The learning loop, run end to end:
 *
 *   promote real corrections into cases
 *     -> replay every case against the current engine
 *       -> cluster the failures
 *         -> raise a proposal a human must approve
 *
 *   npm run eval              full loop
 *   npm run eval -- --no-propose   score only
 *   npm run eval -- --task extract_objections
 *
 * Exits non-zero when the pass rate drops below the floor, so it can gate CI.
 */

const FLOOR = Number(process.env['EVAL_PASS_FLOOR'] ?? 0.7);

async function main() {
  const args = process.argv.slice(2);
  const noPropose = args.includes('--no-propose');
  const taskIdx = args.indexOf('--task');
  const task = taskIdx >= 0 ? args[taskIdx + 1] : undefined;

  const { getHandle } = await import('./client');
  const handle = await getHandle();

  const [workspace] = await handle.db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.isDemo, true))
    .limit(1);

  if (!workspace) {
    console.error('✗ No workspace found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const { systemCtx } = await import('@/server/context');
  const ctx = await systemCtx(workspace.id, 'Evaluation run');

  console.log(`▸ Learning loop — ${workspace.name}\n`);

  /* 0 — make sure the corpus is not empty: the test-suite behaviours are
   *     cases too, so a fresh install has something to score against. */
  const { bootstrapEvalCases } = await import('@/server/learning/bootstrap');
  const boot = await bootstrapEvalCases(ctx);
  if (boot.created > 0) console.log(`  seeded ${boot.created} regression case(s) from the test suite`);

  /* 1 — distil new corrections into cases */
  const { promoteSignals } = await import('@/server/learning/promote');
  const promoted = await promoteSignals(ctx);
  console.log(
    `  promoted ${promoted.created} new case(s) from usage` +
      (promoted.skipped ? `, skipped ${promoted.skipped} unreplayable signal(s)` : ''),
  );

  /* 2 — score */
  const { runEvaluation } = await import('@/server/learning/evaluate');
  const summary = await runEvaluation(ctx, {
    trigger: 'manual',
    ...(task ? { task: task as never } : {}),
  });

  if (summary.total === 0) {
    console.log('\n  No eval cases yet. The corpus grows from real corrections:');
    console.log('  approve, reject or edit an agent proposal and run this again.\n');
    await handle.close();
    return;
  }

  const rate = summary.passed / summary.total;
  console.log(
    `\n  ${summary.passed}/${summary.total} passed (${(rate * 100).toFixed(0)}%) in ${summary.latencyMs}ms\n`,
  );

  const width = Math.max(...Object.keys(summary.byTask).map((k) => k.length), 12);
  for (const [t, s] of Object.entries(summary.byTask).sort()) {
    const pct = s.total ? ((s.passed / s.total) * 100).toFixed(0) : '—';
    const bar = '█'.repeat(Math.round((s.passed / Math.max(s.total, 1)) * 16)).padEnd(16, '·');
    console.log(`  ${t.padEnd(width)}  ${bar}  ${s.passed}/${s.total}  ${pct}%`);
  }

  if (summary.failures.length > 0) {
    console.log(`\n  Failing (${summary.failures.length}):`);
    for (const f of summary.failures.slice(0, 12)) {
      console.log(`    · [${f.task}] ${f.label}`);
      console.log(`        ${f.detail}`);
    }
    if (summary.failures.length > 12) {
      console.log(`    … and ${summary.failures.length - 12} more`);
    }
  }

  /* 3 — propose, through the approval gate */
  if (!noPropose && summary.failures.length > 0) {
    const { proposeImprovements, raiseProposals } = await import('@/server/learning/propose');
    const drafts = await proposeImprovements(ctx, summary.runId);
    if (drafts.length === 0) {
      console.log('\n  No failure cluster large enough to propose a change for.');
    } else {
      const raised = await raiseProposals(ctx, summary.runId, drafts);
      console.log(`\n  ${raised.created} improvement proposal(s) awaiting human approval:`);
      for (const d of drafts) {
        console.log(`    · ${d.title}`);
        console.log(`        target: ${d.target}`);
      }
      console.log('\n  Review them at /learning — nothing changes until you approve it.');
    }
  }

  await handle.close();

  if (rate < FLOOR) {
    console.error(
      `\n✗ Pass rate ${(rate * 100).toFixed(0)}% is below the ${(FLOOR * 100).toFixed(0)}% floor.`,
    );
    process.exit(1);
  }
  console.log('');
}

main().catch((err) => {
  console.error('\n✗ Evaluation failed:\n', err);
  process.exit(1);
});
