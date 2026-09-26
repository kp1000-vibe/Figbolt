import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CLICK_CEILING, CLICK_JOBS, budgetSummary, overBudget } from '@/lib/ux/click-budget';
import { buildPayload, parseCommand, daysUntilWeekday } from '@/lib/ux/commands';
import { ensureToolsLoaded } from '@/lib/agents/dispatch';
import { getTool } from '@/lib/agents/registry';

/**
 * The click budget, enforced.
 *
 * "Under three clicks" is a claim anyone can make in a deck. These tests are
 * what make it true in the build: every declared job is checked against the
 * ceiling, every route it names must exist as a real page, and every tool it
 * dispatches must be registered with a payload that satisfies that tool's own
 * schema. Rename a tool or delete a route and this fails rather than quietly
 * turning a one-step job into a dead end.
 */

beforeAll(async () => {
  await ensureToolsLoaded();
});

const APP = path.resolve(process.cwd(), 'src/app');

/** Does a route exist as a page on disk, in any route group? */
function routeExists(route: string): boolean {
  const segments = route.replace(/^\//, '').split('/').filter(Boolean);
  const groups = ['', '(app)', '(auth)', '(setup)'];

  for (const group of groups) {
    const direct = path.join(APP, group, ...segments, 'page.tsx');
    if (existsSync(direct)) return true;
    // Dynamic segments: /agents/new is literal, but /accounts/[id] is not a
    // declared job — so only the literal form is checked here.
  }
  return segments.length === 0 && existsSync(path.join(APP, 'page.tsx'));
}

describe('the budget holds', () => {
  it('has no job over the ceiling', () => {
    const over = overBudget();
    expect(
      over.map((j) => `${j.id} needs ${j.steps.length}`),
      'jobs exceeding the click ceiling',
    ).toEqual([]);
  });

  it('keeps the everyday writes at two steps or fewer', () => {
    // The jobs that consume the non-selling 60% are the ones that must be
    // nearly free. Drafting is the documented exception at three, because
    // sending needs a human.
    const everyday = ['log-call', 'create-followup', 'move-stage', 'add-account'];
    for (const id of everyday) {
      const job = CLICK_JOBS.find((j) => j.id === id);
      expect(job, id).toBeDefined();
      expect(job!.steps.length, `${id}: ${job!.steps.join(' -> ')}`).toBeLessThanOrEqual(2);
    }
  });

  it('every declared route is a real page', () => {
    const missing = CLICK_JOBS.filter((j) => j.route && !routeExists(j.route)).map(
      (j) => `${j.id} -> ${j.route}`,
    );
    expect(missing, 'jobs pointing at routes that do not exist').toEqual([]);
  });

  it('every declared tool is registered', () => {
    const missing = CLICK_JOBS.filter((j) => j.tool && !getTool(j.tool)).map(
      (j) => `${j.id} -> ${j.tool}`,
    );
    expect(missing, 'jobs dispatching unregistered tools').toEqual([]);
  });

  it('reports a summary worth showing a buyer', () => {
    const s = budgetSummary();
    expect(s.total).toBeGreaterThanOrEqual(15);
    expect(s.worst).toBeLessThanOrEqual(CLICK_CEILING);
    expect(s.average).toBeLessThan(2.5);
  });
});

describe('command parsing', () => {
  it('logs a call', () => {
    const c = parseCommand('log call with Acme went well, they want pricing');
    expect(c?.kind).toBe('log_note');
    expect(c?.rest).toContain('Acme');
  });

  it('creates a task and understands a weekday', () => {
    const c = parseCommand('task send the security pack friday');
    expect(c?.kind).toBe('create_task');
    expect(c?.rest).toBe('send the security pack');
    expect(c?.dueInDays).toBeGreaterThanOrEqual(1);
    expect(c?.dueInDays).toBeLessThanOrEqual(7);
  });

  it('understands “tomorrow” and “in 3 days”', () => {
    expect(parseCommand('task call procurement tomorrow')?.dueInDays).toBe(1);
    expect(parseCommand('task chase legal in 3 days')?.dueInDays).toBe(3);
  });

  it('defaults a bare follow-up to a sensible title', () => {
    const c = parseCommand('follow up with Halcyon');
    expect(c?.kind).toBe('create_task');
    expect(c?.rest.length).toBeGreaterThan(2);
  });

  it('moves a deal, matching a stage by prefix', () => {
    const c = parseCommand('move Acme to negotiation');
    expect(c?.kind).toBe('move_stage');
    expect(c?.stage).toBe('negotiation');
    expect(parseCommand('move Acme to nego')?.stage).toBe('negotiation');
  });

  it('does not invent a stage that does not exist', () => {
    expect(parseCommand('move Acme to the moon')).toBeNull();
  });

  it('creates records from a name', () => {
    expect(parseCommand('new account Harborline Freight')?.newName).toBe('Harborline Freight');
    expect(parseCommand('add contact Lena Ortiz')?.kind).toBe('create_contact');
  });

  it('treats a question as a question, never a command', () => {
    // Otherwise "should I move Acme to negotiation?" would write to the CRM.
    expect(parseCommand('should I move Acme to negotiation?')).toBeNull();
    expect(parseCommand('which deals are at risk?')).toBeNull();
  });

  it('leaves a bare name alone so it stays a navigation', () => {
    expect(parseCommand('Acme Corp')).toBeNull();
    expect(parseCommand('Solstice')).toBeNull();
  });

  it('computes the next weekday, never today', () => {
    const monday = new Date('2026-09-28T12:00:00Z'); // a Monday
    expect(daysUntilWeekday('monday', monday)).toBe(7);
    expect(daysUntilWeekday('friday', monday)).toBe(4);
  });
});

describe('payloads satisfy the tools they dispatch', () => {
  const account = { type: 'account', id: 'acc_1', name: 'Acme Corp' };
  const deal = { type: 'opportunity', id: 'opp_1', name: 'Acme — Platform' };

  it('builds a valid add_note payload', () => {
    const c = parseCommand('log call with Acme, they confirmed budget')!;
    const payload = buildPayload(c, account);
    expect(payload).not.toBeNull();
    // The real schema is the judge, not our guess at it.
    const parsed = getTool('add_note')!.input.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('builds a valid create_task payload', () => {
    const c = parseCommand('task send the SOC 2 pack tomorrow')!;
    const parsed = getTool('create_task')!.input.safeParse(buildPayload(c, account));
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('builds a valid change_pipeline_stage payload, reason included', () => {
    const c = parseCommand('move Acme to proposal')!;
    const payload = buildPayload(c, deal) as Record<string, unknown>;
    // change_pipeline_stage requires a reason; omitting it was a real bug.
    expect(payload['reason']).toBeTruthy();
    const parsed = getTool('change_pipeline_stage')!.input.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('builds a valid create_account payload', () => {
    const c = parseCommand('new account Harborline Freight')!;
    const parsed = getTool('create_account')!.input.safeParse(buildPayload(c));
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('refuses rather than guessing when a target is missing', () => {
    const log = parseCommand('log call, went well')!;
    expect(buildPayload(log, undefined)).toBeNull();

    const move = parseCommand('move Acme to proposal')!;
    // A stage move needs the deal, not the account it belongs to.
    expect(buildPayload(move, account)).toBeNull();
  });

  it('refuses a one-word contact rather than inventing a surname', () => {
    const c = parseCommand('add contact Lena')!;
    expect(buildPayload(c, account)).toBeNull();
  });
});

describe('no command escapes the gate', () => {
  it('routes every write through a registered, risk-classed tool', () => {
    const inputs = [
      'log call with Acme about pricing',
      'task follow up friday',
      'move Acme to negotiation',
      'new account Foo Ltd',
      'add contact Lena Ortiz',
    ];
    for (const input of inputs) {
      const c = parseCommand(input);
      expect(c, input).not.toBeNull();
      if (c!.via !== 'tool') continue;
      const tool = getTool(c!.tool);
      expect(tool, `${input} -> ${c!.tool}`).toBeDefined();
      // A shortcut must not be a way to skip approval: every one of these
      // mutates, so every one must carry a preview for the approver.
      expect(tool!.readOnly).toBe(false);
      expect(typeof tool!.preview).toBe('function');
    }
  });

  it('never classes a command as low risk', () => {
    // Low risk means "runs unattended". Nothing a command bar writes qualifies.
    for (const input of ['log call with Acme', 'task chase legal', 'move Acme to proposal']) {
      expect(parseCommand(input)!.risk).not.toBe('low');
    }
  });
});
