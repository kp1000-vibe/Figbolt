import 'dotenv/config';
import { askJev, choice, jevConfigured, noul, score, JEV_MODEL_ID } from './jev';

/**
 * One real call to Jev, so you can watch it answer.
 *
 *   npm run jev:check
 *
 * All three question types against one state, in a single parallel call. It
 * prints the answers, the latency and the real cost from the usage block, and
 * on failure prints the exact error rather than a summary — a routing layer
 * that fails quietly is the thing worth being afraid of.
 *
 * Nothing in the CRM is touched and no customer data is sent: the state is the
 * fictional email below.
 */

const EMAIL = `Hi, we run an online skincare store and want an AI agent to answer our order
emails. Budget is signed off and we want to start next month. Can we book a
call this week?`;

async function main() {
  console.log(`\n▸ Jev check — ${JEV_MODEL_ID}\n`);

  if (!jevConfigured()) {
    console.log('  TYPESAFE_API_KEY is not set, so there is nothing to call.\n');
    console.log('  1. Get a key from the TypeSafe dashboard — https://typesafe.ai');
    console.log('  2. Put it in .env as TYPESAFE_API_KEY=...');
    console.log('  3. Set JEV_ROUTER=on to let it pick models');
    console.log('\n  Until then the router stays off and every job uses the default model.\n');
    process.exit(1);
  }

  const started = Date.now();
  const result = await askJev(
    // A named field rather than a bare string: it tells Jev what it is reading.
    { inbound_email: EMAIL },
    {
      lead: score('How strong a sales lead is this email?', [
        'Not a lead at all.',
        'Cold — curiosity, no stated need.',
        'Warm — a real need, but no budget or timeline.',
        'Hot — a clear need with budget and a timeline stated.',
      ]),
      kind: choice('What kind of email is this?', {
        new_lead: 'Someone who might buy, making first contact.',
        existing_client: 'Someone already a customer.',
        vendor_pitch: 'Someone selling something to us.',
        support: 'A problem with something they already have.',
        job_seeker: 'Someone asking about work.',
        other: 'None of the above.',
      }),
      needs_human_today: noul('This needs a personal reply from a human today.'),
    },
  );

  if (!result) {
    console.error('  ✗ No answer. The warning above says why.\n');
    console.error('  Common causes: a rejected key, no credit on the account, or the');
    console.error('  endpoint having moved — see https://docs.typesafe.ai/api.md\n');
    process.exit(1);
  }

  const wall = Date.now() - started;
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'noul') {
      console.log(`  ${id.padEnd(18)} ${answer.noul.toFixed(2)} probability`);
    } else if (answer.type === 'score') {
      console.log(
        `  ${id.padEnd(18)} ${answer.score.toFixed(2)} of ${answer.levels - 1}`.padEnd(40) +
          `confidence ${answer.confidence.toFixed(2)}`,
      );
    } else {
      console.log(
        `  ${id.padEnd(18)} ${answer.choice}`.padEnd(40) +
          `confidence ${answer.confidence.toFixed(2)}`,
      );
    }
  }

  console.log(
    `\n  ${result.latencyMs}ms from Jev (${wall}ms wall) · ${result.inputTokens} input tokens · $${result.costUsd.toFixed(
      7,
    )}`,
  );
  console.log('\n  Output is free — you only pay for what you send.\n');
}

main().catch((err) => {
  console.error('\n✗ Jev check failed:\n', err);
  process.exit(1);
});
