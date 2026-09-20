import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agents,
  automationRuns,
  automations,
  users,
  type AutomationAction,
  type AutomationTrigger,
  type ConditionNode,
} from '@/db/schema';
import { NotFoundError, scope, scoped, ValidationError, type Ctx } from '../context';
import { ctxAssert } from '../context';
import { record } from '../audit';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import { isValidCron, nextRunFor } from '../agents/manage';

/**
 * The no-code automation engine.
 *
 * Conditions are a small typed expression tree, evaluated in TypeScript against
 * a flat fact map — never compiled to SQL or `eval`'d. That keeps a user-authored
 * condition incapable of reading anything the trigger did not already provide.
 *
 * Actions run through the same `dispatchTool` chokepoint as agents, so an
 * automation cannot bypass the permission or approval model by being "just
 * config".
 */

export type AutomationFacts = Record<string, string | number | boolean | null>;

/* ── Condition evaluation ─────────────────────────────────────────────────── */

export function evaluateCondition(node: ConditionNode | null, facts: AutomationFacts): boolean {
  // No condition means "always" — the trigger alone decides.
  if (!node) return true;

  if (node.op === 'and') return node.children.every((child) => evaluateCondition(child, facts));
  if (node.op === 'or') return node.children.some((child) => evaluateCondition(child, facts));

  const actual = facts[node.field] ?? null;
  const expected = node.value;

  switch (node.comparator) {
    case 'eq':
      return String(actual) === String(expected);
    case 'neq':
      return String(actual) !== String(expected);
    case 'gt':
      return numeric(actual) > numeric(expected);
    case 'gte':
      return numeric(actual) >= numeric(expected);
    case 'lt':
      return numeric(actual) < numeric(expected);
    case 'lte':
      return numeric(actual) <= numeric(expected);
    case 'contains':
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'not_contains':
      return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'is_empty':
      return actual === null || actual === '' || actual === undefined;
    case 'is_not_empty':
      return actual !== null && actual !== '' && actual !== undefined;
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual));
    default:
      return false;
  }
}

function numeric(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Human-readable condition, for the list and detail views. */
export function describeCondition(node: ConditionNode | null): string {
  if (!node) return 'Always runs when triggered';
  if (node.op === 'and') return node.children.map(describeCondition).join(' AND ');
  if (node.op === 'or') return `(${node.children.map(describeCondition).join(' OR ')})`;

  const comparators: Record<string, string> = {
    eq: 'is',
    neq: 'is not',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    contains: 'contains',
    not_contains: 'does not contain',
    is_empty: 'is empty',
    is_not_empty: 'is set',
    in: 'is one of',
  };

  const field = node.field.replace(/\./g, ' ').replace(/([A-Z])/g, ' $1').toLowerCase();
  const comparator = comparators[node.comparator] ?? node.comparator;

  if (node.comparator === 'is_empty' || node.comparator === 'is_not_empty') {
    return `${field} ${comparator}`;
  }
  const value =
    typeof node.value === 'number' ? node.value.toLocaleString() : String(node.value ?? '');
  return `${field} ${comparator} ${value}`;
}

export function describeAutomationTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === 'schedule') return `On a schedule · ${trigger.cron} (${trigger.timezone})`;
  if (trigger.kind === 'webhook') return 'On an inbound webhook';
  return `When ${trigger.event.replace(/[._]/g, ' ')}`;
}

/* ── Execution ────────────────────────────────────────────────────────────── */

export type RunAutomationResult = {
  runId: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval';
  conditionResult: boolean;
  actionResults: { actionId: string; kind: string; status: string; detail?: string }[];
};

export async function runAutomation(
  ctx: Ctx,
  automationId: string,
  triggerPayload: AutomationFacts = {},
): Promise<RunAutomationResult> {
  await ensureToolsLoaded();

  const [automation] = await ctx.db
    .select()
    .from(automations)
    .where(and(scope(ctx, automations), eq(automations.id, automationId)))
    .limit(1);
  if (!automation) throw new NotFoundError('Automation', automationId);

  const [run] = await ctx.db
    .insert(automationRuns)
    .values({
      workspaceId: ctx.workspaceId,
      automationId,
      status: 'running',
      triggerPayload,
      startedAt: new Date(),
    })
    .returning({ id: automationRuns.id });

  const runId = run!.id;
  const conditionResult = evaluateCondition(automation.conditions, triggerPayload);

  if (!conditionResult) {
    await ctx.db
      .update(automationRuns)
      .set({ status: 'skipped', conditionResult: false, finishedAt: new Date() })
      .where(eq(automationRuns.id, runId));

    await ctx.db
      .update(automations)
      .set({ lastRunAt: new Date(), runCount: sql`${automations.runCount} + 1` })
      .where(eq(automations.id, automationId));

    return { runId, status: 'skipped', conditionResult: false, actionResults: [] };
  }

  const actionResults: RunAutomationResult['actionResults'] = [];
  let sawError = false;
  let sawApproval = false;

  for (const action of automation.actions) {
    try {
      const outcome = await executeAction(ctx, action, triggerPayload, automationId);
      actionResults.push(outcome);
      if (outcome.status === 'awaiting_approval') sawApproval = true;
      if (outcome.status === 'error') sawError = true;
    } catch (err) {
      sawError = true;
      actionResults.push({
        actionId: action.id,
        kind: action.kind,
        status: 'error',
        detail: (err as Error).message.slice(0, 300),
      });
    }
  }

  const status = sawError ? 'failed' : sawApproval ? 'awaiting_approval' : 'succeeded';

  await ctx.db
    .update(automationRuns)
    .set({
      status,
      conditionResult: true,
      actionResults,
      error: sawError ? actionResults.find((r) => r.status === 'error')?.detail ?? null : null,
      finishedAt: new Date(),
    })
    .where(eq(automationRuns.id, runId));

  await ctx.db
    .update(automations)
    .set({
      lastRunAt: new Date(),
      runCount: sql`${automations.runCount} + 1`,
      ...(sawError ? { errorCount: sql`${automations.errorCount} + 1` } : {}),
      ...(automation.trigger.kind === 'schedule'
        ? { nextRunAt: nextRunFor(automation.trigger.cron) }
        : {}),
    })
    .where(eq(automations.id, automationId));

  await record(ctx, {
    action: `automation.run_${status}`,
    resourceType: 'automation',
    resourceId: automationId,
    riskLevel: 'low',
    metadata: { runId, actions: actionResults.length },
  });

  return { runId, status, conditionResult: true, actionResults };
}

async function executeAction(
  ctx: Ctx,
  action: AutomationAction,
  facts: AutomationFacts,
  automationId: string,
): Promise<{ actionId: string; kind: string; status: string; detail?: string }> {
  const params = interpolate(action.params, facts);

  switch (action.kind) {
    case 'ask_ai': {
      const { ask } = await import('../ai/ask');
      const question = String(params['question'] ?? 'Summarise what changed.');
      const result = await ask(ctx, {
        question,
        persist: false,
        scopeType: facts['opportunity.id'] ? 'opportunity' : facts['account.id'] ? 'account' : undefined,
        scopeId: String(facts['opportunity.id'] ?? facts['account.id'] ?? '') || undefined,
      });
      return {
        actionId: action.id,
        kind: action.kind,
        status: 'ok',
        detail: result.answer.slice(0, 300),
      };
    }

    case 'run_agent': {
      const name = String(params['agentName'] ?? '');
      const [agent] = await ctx.db
        .select({ id: agents.id })
        .from(agents)
        .where(scoped(ctx, agents, eq(agents.name, name)))
        .limit(1);
      if (!agent) {
        return { actionId: action.id, kind: action.kind, status: 'error', detail: `No agent named "${name}".` };
      }

      const { runAgent } = await import('../agents/runtime');
      const outcome = await runAgent(ctx, agent.id, {
        kind: 'event',
        detail: `Automation ${automationId}`,
        input: facts as Record<string, unknown>,
      });
      return {
        actionId: action.id,
        kind: action.kind,
        status: outcome.status === 'awaiting_approval' ? 'awaiting_approval' : 'ok',
        detail: outcome.summary.slice(0, 300),
      };
    }

    case 'call_webhook': {
      // Outbound HTTP is intentionally not implemented in demo mode: silently
      // POSTing customer data to an arbitrary URL is exactly the sort of thing
      // that should require deliberate configuration, not a default.
      return {
        actionId: action.id,
        kind: action.kind,
        status: 'skipped',
        detail: 'Outbound webhooks require a configured endpoint and signing secret.',
      };
    }

    case 'send_slack': {
      return {
        actionId: action.id,
        kind: action.kind,
        status: 'skipped',
        detail: 'Connect Slack in Integrations to enable notifications.',
      };
    }

    default: {
      // Everything else maps onto an agent tool, so it inherits the same
      // permission checks, risk gating and audit trail.
      const toolName = ACTION_TO_TOOL[action.kind];
      if (!toolName) {
        return { actionId: action.id, kind: action.kind, status: 'error', detail: 'Unknown action.' };
      }

      const outcome = await dispatchTool(ctx, toolName, params, {
        rationale: `Automation ${automationId}, action ${action.id}.`,
        // An automation's actions were authored by a human, so the automation
        // asks to run low and medium unattended — but the workspace policy
        // still has the final say, and it ships with medium switched off.
        autoApprove: ['low', 'medium'],
      });

      if (outcome.status === 'ok') {
        return { actionId: action.id, kind: action.kind, status: 'ok', detail: outcome.result.summary };
      }
      if (outcome.status === 'needs_approval') {
        return {
          actionId: action.id,
          kind: action.kind,
          status: 'awaiting_approval',
          detail: outcome.title,
        };
      }
      return { actionId: action.id, kind: action.kind, status: 'error', detail: outcome.error };
    }
  }
}

const ACTION_TO_TOOL: Partial<Record<AutomationAction['kind'], string>> = {
  update_record: 'update_record',
  create_task: 'create_task',
  draft_email: 'draft_email',
  add_note: 'add_note',
};

/**
 * Replace `{{fact.path}}` placeholders from the trigger payload.
 *
 * Values are substituted as plain strings and never parsed as code, so a
 * template cannot become an expression.
 */
function interpolate(
  params: Record<string, unknown>,
  facts: AutomationFacts,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    out[key] = value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
      const fact = facts[path];
      return fact == null ? '' : String(fact);
    });
  }
  return out;
}

/* ── CRUD ─────────────────────────────────────────────────────────────────── */

export async function listAutomations(ctx: Ctx) {
  return ctx.db
    .select({
      id: automations.id,
      name: automations.name,
      description: automations.description,
      trigger: automations.trigger,
      conditions: automations.conditions,
      actions: automations.actions,
      enabled: automations.enabled,
      lastRunAt: automations.lastRunAt,
      nextRunAt: automations.nextRunAt,
      runCount: automations.runCount,
      errorCount: automations.errorCount,
      createdByName: users.name,
    })
    .from(automations)
    .leftJoin(users, eq(users.id, automations.createdById))
    .where(scope(ctx, automations))
    .orderBy(desc(automations.enabled), automations.name);
}

export async function getAutomation(ctx: Ctx, automationId: string) {
  const [automation] = await ctx.db
    .select()
    .from(automations)
    .where(and(scope(ctx, automations), eq(automations.id, automationId)))
    .limit(1);
  if (!automation) throw new NotFoundError('Automation', automationId);

  const runs = await ctx.db
    .select()
    .from(automationRuns)
    .where(scoped(ctx, automationRuns, eq(automationRuns.automationId, automationId)))
    .orderBy(desc(automationRuns.startedAt))
    .limit(25);

  return { automation, runs };
}

export type SaveAutomationInput = {
  id?: string;
  name: string;
  description?: string;
  trigger: AutomationTrigger;
  conditions: ConditionNode | null;
  actions: AutomationAction[];
  enabled?: boolean;
};

export async function saveAutomation(ctx: Ctx, input: SaveAutomationInput): Promise<string> {
  ctxAssert(ctx, 'automation:manage');

  if (input.trigger.kind === 'schedule' && !isValidCron(input.trigger.cron)) {
    throw new ValidationError('That cron expression is not valid. Use five fields, e.g. "0 8 * * 1-5".');
  }
  if (input.actions.length === 0) {
    throw new ValidationError('An automation needs at least one action.');
  }

  const values = {
    workspaceId: ctx.workspaceId,
    name: input.name,
    description: input.description ?? null,
    trigger: input.trigger,
    conditions: input.conditions,
    actions: input.actions,
    enabled: input.enabled ?? true,
    nextRunAt: input.trigger.kind === 'schedule' ? nextRunFor(input.trigger.cron) : null,
  };

  if (input.id) {
    await ctx.db
      .update(automations)
      .set(values)
      .where(and(scope(ctx, automations), eq(automations.id, input.id)));

    await record(ctx, {
      action: 'automation.updated',
      resourceType: 'automation',
      resourceId: input.id,
      riskLevel: 'medium',
      metadata: { name: input.name },
    });
    return input.id;
  }

  const [created] = await ctx.db
    .insert(automations)
    .values({ ...values, createdById: ctx.userId })
    .returning({ id: automations.id });

  await record(ctx, {
    action: 'automation.created',
    resourceType: 'automation',
    resourceId: created!.id,
    riskLevel: 'medium',
    metadata: { name: input.name, actions: input.actions.length },
  });

  return created!.id;
}

export async function setAutomationEnabled(ctx: Ctx, automationId: string, enabled: boolean) {
  ctxAssert(ctx, 'automation:manage');
  await ctx.db
    .update(automations)
    .set({ enabled })
    .where(and(scope(ctx, automations), eq(automations.id, automationId)));

  await record(ctx, {
    action: enabled ? 'automation.enabled' : 'automation.disabled',
    resourceType: 'automation',
    resourceId: automationId,
    riskLevel: 'medium',
  });
}

export async function deleteAutomation(ctx: Ctx, automationId: string) {
  ctxAssert(ctx, 'automation:manage');
  await ctx.db
    .update(automations)
    .set({ deletedAt: new Date(), enabled: false })
    .where(and(scope(ctx, automations), eq(automations.id, automationId)));

  await record(ctx, {
    action: 'automation.deleted',
    resourceType: 'automation',
    resourceId: automationId,
    riskLevel: 'high',
  });
}
