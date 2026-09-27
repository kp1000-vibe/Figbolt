import 'dotenv/config';
import { askJev, jevConfigured, JEV_MODEL_ID } from './jev';

/**
 * One real call to Jev, so you can watch it answer.
 *
 *   npm run jev:check
 *
 * The guide asks for a live test with a made-up sales email and three typed
 * questions. This is that test. It prints Jev's answers, the latency and the
 * cost, and on failure prints the exact error rather than a summary — a
 * routing layer that fails quietly is the thing worth being afraid of.
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
    console.log('  OPENROUTER_API_KEY is not set, so there is nothing to call.\n');
    console.log('  1. Get a key at https://openrouter.ai/keys');
    console.log('  2. Add a little credit — this test costs about $0.00002');
    console.log('  3. Put it in .env as OPENROUTER_API_KEY=sk-or-...');
    console.log('\n  Until then the router stays off and every job uses the default model.\n');
    process.exit(1);
  }

  const started = Date.now();
  const result = await askJev(EMAIL, [
    {
      id: 'lead',
      kind: 'score',
      question:
        'How strong a lead is this? 0 = not a lead, 1 = cold, 2 = warm, 3 = hot (clear need, stated budget, stated timeline).',
      min: 0,
      max: 3,
    },
    {
      id: 'kind',
      kind: 'choice',
      question: 'What kind of email is this?',
      options: ['new lead', 'existing client', 'vendor pitch', 'spam', 'job seeker', 'support'],
    },
    {
      id: 'reply',
      kind: 'noul',
      question: 'This needs a personal reply from a human today.',
    },
  ]);

  if (!result) {
    console.error('  ✗ No answer. The warning above says why.\n');
    console.error('  Common causes: no credit on the OpenRouter account, a key without');
    console.error('  access to the alpha decisions route, or the route having moved —');
    console.error('  see https://docs.typesafe.ai/llms.txt\n');
    process.exit(1);
  }

  const wall = Date.now() - started;
  for (const [id, answer] of Object.entries(result.answers)) {
    const sure = `confidence ${answer.confidence.toFixed(2)}`;
    console.log(`  ${id.padEnd(6)} ${String(answer.value).padEnd(12)} ${sure}`);
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
