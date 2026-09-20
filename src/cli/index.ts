#!/usr/bin/env node
/**
 * Nexus CLI.
 *
 * A third way into the same product, alongside the web app and the MCP server.
 * It is deliberately a *client of the public API* rather than a script with
 * database access: if the CLI can do something, an API key can do it, and every
 * call is rate-limited, permission-checked and audited exactly like any other.
 *
 * The one exception is `keys:create`, which needs a human session — you cannot
 * bootstrap an API key with an API key. It reads your password interactively
 * and never accepts one as an argument, so it does not end up in shell history.
 *
 *   npm run cli -- keys:create --name "laptop" --role member
 *   npm run cli -- accounts:list --limit 5
 *   npm run cli -- ask "which deals are at risk and why?"
 *   npm run cli -- agents:list
 *   npm run cli -- agents:run <agentId> --input '{"accountId":"acc_..."}'
 *   npm run cli -- tools:call get_account --input '{"accountId":"acc_..."}'
 *   npm run cli -- approvals:list
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const BASE = process.env['NEXUS_API_URL'] ?? 'http://localhost:3000';

type Argv = { positional: string[]; flags: Record<string, string | boolean> };

function parseArgv(argv: string[]): Argv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function requireKey(): string {
  const key = process.env['NEXUS_API_KEY'];
  if (!key) {
    fail(
      'NEXUS_API_KEY is not set.\n' +
        '  Create one with:  npm run cli -- keys:create --name "cli"\n' +
        '  Then:             export NEXUS_API_KEY=nxk_...',
    );
  }
  return key;
}

async function api(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${requireKey()}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }).catch((err: Error) => {
    fail(`Could not reach ${BASE}. Is the dev server running?\n  ${err.message}`);
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const detail = typeof json['error'] === 'string' ? json['error'] : `HTTP ${res.status}`;
    fail(detail);
  }

  // 202 means the write was accepted but is waiting for a human. Saying
  // "done" here would be a lie the caller would act on.
  if (res.status === 202) {
    console.log('\n⏸  Queued for approval — NOT performed.');
    console.log(JSON.stringify(json, null, 2));
    return json;
  }

  return 'data' in json ? json['data'] : json;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function print(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function table(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((col) =>
    Math.min(48, Math.max(col.length, ...rows.map((row) => cell(row[col]).length))),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.slice(0, widths[i]!).padEnd(widths[i]!)).join('  ');

  console.log(line(columns));
  console.log(line(widths.map((w) => '─'.repeat(w))));
  for (const row of rows) {
    console.log(line(columns.map((col) => cell(row[col]))));
  }
}

/**
 * One table cell.
 *
 * API values are not all strings — a trigger is an object, `enabled` is a
 * boolean — and `String(value)` turns the interesting ones into
 * "[object Object]". Objects render by their most human field.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length === 0 ? '' : `${value.length}`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['label', 'name', 'title', 'kind', 'summary']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    return JSON.stringify(obj).slice(0, 48);
  }
  return String(value);
}

function parseInput(flags: Argv['flags']): Record<string, unknown> {
  const raw = flags['input'];
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('--input must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch {
    return fail('--input is not valid JSON.');
  }
}

/* ── Commands ─────────────────────────────────────────────────────────────── */

const COMMANDS: Record<string, { summary: string; run: (argv: Argv) => Promise<void> }> = {
  'keys:create': {
    summary: 'Create an API key (prompts for your Nexus password).',
    async run({ flags }) {
      const name = typeof flags['name'] === 'string' ? flags['name'] : 'CLI';
      const role = typeof flags['role'] === 'string' ? flags['role'] : undefined;

      const rl = createInterface({ input: stdin, output: stdout });
      const email = typeof flags['email'] === 'string' ? flags['email'] : await rl.question('Email: ');
      // Node has no portable no-echo prompt; the warning is more honest than
      // pretending the input is hidden.
      console.log('(your password will be visible as you type)');
      const password = await rl.question('Password: ');
      rl.close();

      const res = await fetch(`${BASE}/api/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, name, role }),
      }).catch((err: Error) => fail(`Could not reach ${BASE}: ${err.message}`));

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) fail(typeof json['error'] === 'string' ? json['error'] : `HTTP ${res.status}`);

      console.log('\n✓ API key created. This is the only time it will be shown.\n');
      console.log(`  ${String(json['key'])}\n`);
      console.log('  export NEXUS_API_KEY=' + String(json['key']) + '\n');
    },
  },

  'accounts:list': {
    summary: 'List accounts.',
    async run({ flags }) {
      const limit = typeof flags['limit'] === 'string' ? flags['limit'] : '20';
      const data = (await api(`/accounts?limit=${encodeURIComponent(limit)}`)) as {
        accounts?: Record<string, unknown>[];
      };
      table(data.accounts ?? [], ['id', 'name', 'industry', 'healthScore', 'openPipeline']);
    },
  },

  'accounts:get': {
    summary: 'Show one account with its derived memory.',
    async run({ positional }) {
      const id = positional[1];
      if (!id) fail('Usage: accounts:get <accountId>');
      print(await api(`/accounts/${encodeURIComponent(id)}`));
    },
  },

  'deals:list': {
    summary: 'List opportunities.',
    async run({ flags }) {
      const limit = typeof flags['limit'] === 'string' ? flags['limit'] : '20';
      const data = (await api(`/opportunities?limit=${encodeURIComponent(limit)}`)) as {
        opportunities?: Record<string, unknown>[];
      };
      table(data.opportunities ?? [], ['id', 'name', 'stage', 'value', 'healthScore']);
    },
  },

  ask: {
    summary: 'Ask a question about your customers.',
    async run({ positional }) {
      const question = positional.slice(1).join(' ');
      if (!question) fail('Usage: ask "your question"');

      const data = (await api('/ask', { method: 'POST', body: { question } })) as {
        answer?: string;
        confidence?: number;
        sources?: { label?: string; type?: string }[];
      };

      console.log(`\n${data.answer ?? '(no answer)'}\n`);
      if (data.sources?.length) {
        console.log('Sources:');
        for (const [i, source] of data.sources.entries()) {
          console.log(`  [${i + 1}] ${source.type ?? 'record'} — ${source.label ?? ''}`);
        }
      }
      if (typeof data.confidence === 'number') {
        console.log(`\nConfidence: ${Math.round(data.confidence * 100)}%`);
      }
    },
  },

  briefing: {
    summary: 'Your daily briefing.',
    async run() {
      print(await api('/briefing'));
    },
  },

  'inbox:list': {
    summary: 'The AI inbox.',
    async run() {
      const data = (await api('/inbox')) as { items?: Record<string, unknown>[] };
      table(data.items ?? [], ['kind', 'title', 'priority', 'status']);
    },
  },

  'agents:list': {
    summary: 'List agents.',
    async run() {
      const data = (await api('/agents')) as { agents?: Record<string, unknown>[] };
      table(data.agents ?? [], ['id', 'name', 'enabled', 'trigger', 'lastRunAt']);
    },
  },

  'agents:run': {
    summary: 'Run an agent. High-risk actions still require human approval.',
    async run({ positional, flags }) {
      const id = positional[1];
      if (!id) fail('Usage: agents:run <agentId> [--input \'{"accountId":"..."}\']');
      print(await api(`/agents/${encodeURIComponent(id)}/run`, { method: 'POST', body: parseInput(flags) }));
    },
  },

  'tools:list': {
    summary: 'List the tools this key may call.',
    async run() {
      const data = (await api('/tools')) as { tools?: Record<string, unknown>[] };
      table(data.tools ?? [], ['name', 'risk', 'readOnly', 'description']);
    },
  },

  'tools:call': {
    summary: 'Call one tool directly.',
    async run({ positional, flags }) {
      const name = positional[1];
      if (!name) fail('Usage: tools:call <toolName> --input \'{...}\'');
      print(await api(`/tools/${encodeURIComponent(name)}`, { method: 'POST', body: parseInput(flags) }));
    },
  },

  'approvals:list': {
    summary: 'Pending approvals.',
    async run() {
      const data = (await api('/approvals')) as { approvals?: Record<string, unknown>[] };
      table(data.approvals ?? [], ['id', 'title', 'riskLevel', 'requestedAt']);
    },
  },

  'approvals:decide': {
    summary: 'Approve or reject a pending action.',
    async run({ positional, flags }) {
      const id = positional[1];
      const decision = typeof flags['decision'] === 'string' ? flags['decision'] : positional[2];
      if (!id || (decision !== 'approve' && decision !== 'reject')) {
        fail('Usage: approvals:decide <approvalId> approve|reject [--reason "..."]');
      }
      print(
        await api(`/approvals/${encodeURIComponent(id)}/decide`, {
          method: 'POST',
          body: { decision, reason: typeof flags['reason'] === 'string' ? flags['reason'] : undefined },
        }),
      );
    },
  },

  'ingest:usage': {
    summary: 'Push a day of product usage for an account.',
    async run({ flags }) {
      print(await api('/ingest/usage', { method: 'POST', body: parseInput(flags) }));
    },
  },

  'ingest:ticket': {
    summary: 'Push a support ticket; extraction runs on it like any other interaction.',
    async run({ flags }) {
      print(await api('/ingest/ticket', { method: 'POST', body: parseInput(flags) }));
    },
  },

  search: {
    summary: 'Hybrid search across the workspace.',
    async run({ positional }) {
      const query = positional.slice(1).join(' ');
      if (!query) fail('Usage: search "terms"');
      print(await api(`/search?q=${encodeURIComponent(query)}`));
    },
  },
};

function usage(): void {
  console.log('\nNexus CRM — command line\n');
  console.log(`  Server:  ${BASE}`);
  console.log(`  Auth:    NEXUS_API_KEY ${process.env['NEXUS_API_KEY'] ? '(set)' : '(not set)'}\n`);
  console.log('Commands:\n');
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, command] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(width)}  ${command.summary}`);
  }
  console.log('\nEverything above goes through the same public API, permission checks and audit');
  console.log('log as the web app. High-risk writes return "queued for approval", never "done".\n');
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  const name = argv.positional[0];

  if (!name || name === 'help' || argv.flags['help']) {
    usage();
    return;
  }

  const command = COMMANDS[name];
  if (!command) {
    console.error(`\n✗ Unknown command: ${name}`);
    usage();
    process.exit(1);
  }

  await command.run(argv);
}

main().catch((err: Error) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
