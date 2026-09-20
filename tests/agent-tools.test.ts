import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, approvals, auditEvents } from '@/db/schema';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import { allTools, getTool } from '@/lib/agents/registry';
import { createHarness, type Harness } from './harness';

/**
 * Agent tool execution.
 *
 * `dispatchTool` is the only path from a model's output to a real effect, so
 * these tests are the ones that decide whether "the LLM cannot bypass business
 * logic" is true or merely intended. Each check corresponds to one gate in the
 * dispatcher: allow-list, permission, validation, risk/approval, audit.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await ensureToolsLoaded();
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

describe('the registry', () => {
  it('requires every mutating tool to provide an approval preview', () => {
    // Without a preview an approver would be asked to authorise an opaque
    // payload. Registration throws on this, so reaching here means it holds.
    for (const tool of allTools()) {
      if (!tool.readOnly) expect(typeof tool.preview).toBe('function');
    }
  });

  it('classifies read tools as low risk and sending email as high', () => {
    expect(getTool('get_account')?.risk).toBe('low');
    expect(getTool('get_account')?.readOnly).toBe(true);
    expect(getTool('send_email')?.risk).toBe('high');
    expect(getTool('draft_email')?.readOnly).toBe(false);
  });
});

describe('gate 1 — allow-list', () => {
  it('refuses a tool outside the agent\'s configured set', async () => {
    const outcome = await dispatchTool(
      h.ctxFor('owner'),
      'send_email',
      { to: ['someone@example.test'], subject: 'Hi', body: 'Hello there, this is a test body.' },
      { allowList: ['get_account', 'search_accounts'], agentId: h.agentId },
    );

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.code).toBe('TOOL_NOT_ALLOWED');
  });

  it('records the denial rather than failing silently', async () => {
    const ctx = h.ctxFor('owner');
    await dispatchTool(ctx, 'create_account', { name: 'Should Not Exist' }, {
      allowList: ['get_account'],
      agentId: h.agentId,
    });

    const denials = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'agent.tool_denied'));

    expect(denials.length).toBeGreaterThan(0);

    const created = await ctx.db
      .select()
      .from(accounts)
      .where(eq(accounts.name, 'Should Not Exist'));
    expect(created).toHaveLength(0);
  });

  it('rejects a tool that does not exist', async () => {
    const outcome = await dispatchTool(h.ctxFor('owner'), 'drop_all_tables', {});
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.code).toBe('UNKNOWN_TOOL');
  });
});

describe('gate 2 — permission', () => {
  it('stops a viewer from creating a record even with a valid payload', async () => {
    const outcome = await dispatchTool(h.ctxFor('viewer'), 'create_account', {
      name: 'Viewer Should Not Create',
    });

    expect(outcome.status).toBe('error');

    const rows = await h.db
      .select()
      .from(accounts)
      .where(eq(accounts.name, 'Viewer Should Not Create'));
    expect(rows).toHaveLength(0);
  });

  it('checks permission before validation, so a denial leaks nothing about the schema', async () => {
    // Deliberately invalid input: a viewer must be refused for lacking rights,
    // not told which fields were wrong.
    const outcome = await dispatchTool(h.ctxFor('viewer'), 'create_account', { nonsense: true });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.code).not.toBe('INVALID_INPUT');
    }
  });
});

describe('gate 3 — validation', () => {
  it('rejects input that does not match the tool schema', async () => {
    const outcome = await dispatchTool(h.ctxFor('owner'), 'create_account', { name: 'x' });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.code).toBe('INVALID_INPUT');
  });

  it('rejects a malformed recipient rather than attempting a send', async () => {
    const outcome = await dispatchTool(
      h.ctxFor('owner'),
      'draft_email',
      { to: ['not-an-address'], subject: 'Test', body: 'A body long enough to pass validation.' },
      { directUserAction: true },
    );
    expect(outcome.status).toBe('error');
  });
});

describe('gate 4 — risk and approval', () => {
  it('runs a low-risk read without approval', async () => {
    const outcome = await dispatchTool(h.ctxFor('owner'), 'get_account', {
      accountId: h.accountId,
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.riskLevel).toBe('low');
  });

  it('queues a high-risk action for a human instead of performing it', async () => {
    const ctx = h.ctxFor('owner');

    const outcome = await dispatchTool(
      ctx,
      'send_email',
      {
        to: ['customer@acme.test'],
        subject: 'Following up',
        body: 'This message must never leave without a human approving it first.',
      },
      { autoApprove: ['low', 'medium'], agentId: h.agentId },
    );

    expect(outcome.status).toBe('needs_approval');
    if (outcome.status === 'needs_approval') {
      expect(outcome.riskLevel).toBe('high');

      const [row] = await ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, outcome.approvalId));

      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');
      // The approver sees the actual payload, not a paraphrase of it.
      expect(JSON.stringify(row!.preview)).toContain('Following up');
    }
  });

  it('never auto-runs a high-risk tool for an agent, whatever policy it was given', async () => {
    const outcome = await dispatchTool(
      h.ctxFor('owner'),
      'send_email',
      {
        to: ['customer@acme.test'],
        subject: 'Agent tried to send',
        body: 'An agent configured to auto-approve everything still must not send this.',
      },
      // The worst-case configuration: an agent claiming it may auto-run anything.
      { autoApprove: ['low', 'medium', 'high'], agentId: h.agentId },
    );

    expect(outcome.status).toBe('needs_approval');
  });

  it('performs a medium-risk write when a human invoked it directly', async () => {
    const ctx = h.ctxFor('owner');

    const outcome = await dispatchTool(
      ctx,
      'create_account',
      { name: 'Dispatched Account', domain: 'dispatched.test' },
      { directUserAction: true },
    );

    expect(outcome.status).toBe('ok');

    const rows = await ctx.db
      .select()
      .from(accounts)
      .where(eq(accounts.name, 'Dispatched Account'));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(ctx.workspaceId);
  });

  it('does not treat a user-authority run as consent for what it composes', async () => {
    // The regression this locks down: an automation or agent run started by a
    // human inherits that human's Ctx. If the dispatcher inferred approval
    // from `actor.type === 'user'`, "run this automation" would silently
    // authorise every action it later decided to take.
    const ctx = h.ctxFor('owner');

    const outcome = await dispatchTool(
      ctx,
      'create_account',
      { name: 'Composed By Automation' },
      // No `directUserAction`: nobody was shown this payload.
      { autoApprove: ['low', 'medium'], rationale: 'Automation action.' },
    );

    expect(outcome.status).toBe('needs_approval');

    const rows = await ctx.db
      .select()
      .from(accounts)
      .where(eq(accounts.name, 'Composed By Automation'));
    expect(rows).toHaveLength(0);
  });
});

describe('gate 5 — audit', () => {
  it('writes an audit row for a successful tool execution', async () => {
    const ctx = h.ctxFor('owner');

    await dispatchTool(
      ctx,
      'create_task',
      { title: 'Audited task from the tool suite', accountId: h.accountId },
      { directUserAction: true },
    );

    const rows = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'task.created'));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.workspaceId).toBe(ctx.workspaceId);
  });
});

describe('tenant isolation through tools', () => {
  it('will not read another tenant\'s account by id', async () => {
    const outcome = await dispatchTool(h.ctxFor('owner'), 'get_account', {
      accountId: h.otherAccountId,
    });

    // Either a clean error or an empty result is acceptable; returning the
    // foreign record is not.
    if (outcome.status === 'ok') {
      expect(JSON.stringify(outcome.result)).not.toContain('Foreign Account');
    } else {
      expect(outcome.status).toBe('error');
    }
  });

  it('creates records only in the caller\'s workspace', async () => {
    const ctx = h.ctxFor('owner');

    await dispatchTool(
      ctx,
      'create_account',
      { name: 'Tenant Bound Account' },
      { directUserAction: true },
    );

    const rows = await h.db
      .select()
      .from(accounts)
      .where(eq(accounts.name, 'Tenant Bound Account'));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(ctx.workspaceId);
    expect(rows[0]!.workspaceId).not.toBe(h.otherWorkspaceId);
  });
});
