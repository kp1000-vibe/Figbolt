import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  approvals,
  users,
  type AgentStepSpec,
  type AgentTrigger,
  type ApprovalPolicy,
  type Role,
} from '@/db/schema';
import { getLanguageModel } from '@/lib/ai';
import { s } from '@/lib/ai/providers/structured';
import { allTools, type RegisteredTool } from '@/lib/agents/registry';
import { ensureToolsLoaded } from '@/lib/agents/dispatch';
import { NotFoundError, scope, scoped, ValidationError, type Ctx } from '../context';
import { ctxAssert } from '../context';
import { record } from '../audit';

/**
 * Agent management: compile a description into a runnable agent, then CRUD.
 *
 * Compilation is a *proposal*, never a silent commit. The user sees the derived
 * trigger, filters, tools and steps and can edit any of them before saving —
 * because an agent that runs on a schedule with the wrong filter is a mistake
 * that repeats itself daily.
 */

export type CompiledAgent = {
  name: string;
  description: string;
  instructions: string;
  trigger: AgentTrigger;
  toolNames: string[];
  steps: AgentStepSpec[];
  filters: Record<string, unknown>;
  outputSchema: { name: string; type: string; description: string; required?: boolean }[];
  approvalPolicy: ApprovalPolicy;
  confidence: number;
};

const COMPILE_SYSTEM = `
You turn a plain-English description of a recurring sales task into an agent configuration.

Rules:
- Choose the narrowest tool set that can do the job. Every extra tool widens what the agent can touch.
- Anything that sends email, deletes data, or changes many records at once must NOT be auto-approved.
- If the description implies a schedule, express it as a cron expression.
- Filters must be concrete numbers and day counts, not adjectives.
- Steps should read as a plan a person could follow and check.
`.trim();

export async function compileAgent(ctx: Ctx, description: string): Promise<CompiledAgent> {
  ctxAssert(ctx, 'agent:manage');
  await ensureToolsLoaded();

  if (description.trim().length < 20) {
    throw new ValidationError(
      'Describe the task in a sentence or two — what to look for, how often, and what to do about it.',
    );
  }

  const tools = allTools();
  const model = getLanguageModel();

  const result = await model.completeStructured<Record<string, unknown>>({
    system: COMPILE_SYSTEM,
    instruction: [
      'Available tools:',
      ...tools.map(
        (t) => `- ${t.name} (${t.readOnly ? 'read-only' : `${t.risk} risk`}): ${t.description}`,
      ),
      '',
      'Agent description:',
      description.trim(),
    ].join('\n'),
    schema: s.object(
      {
        name: s.string('Short agent name, 2-4 words.'),
        description: s.string('One sentence on what it does.'),
        instructions: s.string('Operating instructions for the agent at run time.'),
        trigger: s.nested(
          {
            kind: s.enum(['manual', 'schedule', 'event'], 'How it starts.'),
            cron: s.string('Cron expression when kind=schedule, else empty.'),
            timezone: s.string('IANA timezone, default UTC.'),
            event: s.string('Event name when kind=event, else empty.'),
          },
          'Trigger configuration.',
          ['kind'],
        ),
        toolNames: s.strings('Tool names this agent may use.'),
        steps: s.array(
          s.nested(
            {
              id: s.string('Stable id like step_1.'),
              kind: s.enum(['retrieve', 'analyze', 'tool', 'decide', 'act', 'notify'], 'Step kind.'),
              title: s.string('What this step does.'),
              detail: s.string('Extra detail, or empty.'),
              tool: s.string('Tool used, or empty.'),
            },
            'A step.',
            ['id', 'kind', 'title'],
          ),
          'Ordered plan.',
        ),
        filters: s.nested(
          {
            minValue: s.number('Minimum deal value, or 0.'),
            inactiveDays: s.integer('Days of inactivity, or 0.'),
            status: s.string('Deal status filter, or empty.'),
          },
          'Concrete filters.',
        ),
        autoApprove: s.strings('Risk levels that may run unattended: low, medium, high.'),
        confidence: s.number('0-1 confidence in this compilation.'),
      },
      ['name', 'description', 'instructions', 'trigger', 'toolNames', 'steps', 'confidence'],
    ),
    task: 'compile_agent',
  });

  const v = result.value;
  const validToolNames = new Set(tools.map((t) => t.name));

  // Drop hallucinated tools rather than failing the compile — the user can add
  // whatever is missing in the editor.
  const toolNames = (Array.isArray(v['toolNames']) ? (v['toolNames'] as unknown[]) : [])
    .map(String)
    .filter((name) => validToolNames.has(name));

  const rawTrigger = (v['trigger'] ?? {}) as Record<string, unknown>;
  const trigger = normaliseTrigger(rawTrigger);

  const rawFilters = (v['filters'] ?? {}) as Record<string, unknown>;
  const filters: Record<string, unknown> = {};
  if (Number(rawFilters['minValue']) > 0) filters['minValue'] = Number(rawFilters['minValue']);
  if (Number(rawFilters['inactiveDays']) > 0) {
    filters['inactiveDays'] = Number(rawFilters['inactiveDays']);
  }
  if (typeof rawFilters['status'] === 'string' && rawFilters['status']) {
    filters['status'] = rawFilters['status'];
  }

  /**
   * Auto-approval is intersected with what the tool set actually justifies.
   * A model that suggests auto-approving HIGH risk is overridden here — the
   * policy floor is enforced in code, not requested in a prompt.
   */
  const requested = (Array.isArray(v['autoApprove']) ? (v['autoApprove'] as unknown[]) : ['low'])
    .map(String)
    .filter((r): r is 'low' | 'medium' | 'high' => r === 'low' || r === 'medium' || r === 'high');

  const hasMutatingTool = toolNames.some((name) => {
    const tool = tools.find((t) => t.name === name);
    return tool && !tool.readOnly;
  });

  const autoApprove = requested.filter((level) => {
    if (level === 'high') return false;
    if (level === 'medium' && hasMutatingTool) return false;
    return true;
  });

  return {
    name: String(v['name'] ?? 'Custom agent').slice(0, 80),
    description: String(v['description'] ?? description.slice(0, 160)),
    instructions: String(v['instructions'] ?? description),
    trigger,
    toolNames: toolNames.length > 0 ? toolNames : ['search_opportunities', 'get_recent_activity'],
    steps: normaliseSteps(v['steps']),
    filters,
    outputSchema: [
      { name: 'findings', type: 'string[]', description: 'One line per record acted on.', required: true },
      { name: 'summary', type: 'string', description: 'Short recap for the owner.', required: true },
    ],
    approvalPolicy: {
      autoApprove: autoApprove.length > 0 ? autoApprove : ['low'],
      notify: 'record_owner',
      expiresAfterHours: 48,
    },
    confidence: Number(v['confidence'] ?? result.confidence),
  };
}

function normaliseTrigger(raw: Record<string, unknown>): AgentTrigger {
  const kind = String(raw['kind'] ?? 'manual');

  if (kind === 'schedule') {
    const cron = String(raw['cron'] ?? '').trim();
    return {
      kind: 'schedule',
      // A malformed cron would silently never fire; fall back to weekday 08:00.
      cron: isValidCron(cron) ? cron : '0 8 * * 1-5',
      timezone: String(raw['timezone'] ?? 'UTC') || 'UTC',
    };
  }
  if (kind === 'event') {
    const event = String(raw['event'] ?? '').trim();
    return { kind: 'event', event: event || 'meeting.completed' };
  }
  return { kind: 'manual' };
}

/** Five space-separated fields of digits, `*`, `,`, `-`, `/`. */
export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => /^[\d*,\-/]+$/.test(field));
}

function normaliseSteps(raw: unknown): AgentStepSpec[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set(['retrieve', 'analyze', 'tool', 'decide', 'act', 'notify']);

  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((step, i) => ({
      id: String(step['id'] ?? `step_${i + 1}`),
      kind: (kinds.has(String(step['kind'])) ? String(step['kind']) : 'analyze') as AgentStepSpec['kind'],
      title: String(step['title'] ?? `Step ${i + 1}`),
      detail: step['detail'] ? String(step['detail']) : undefined,
      tool: step['tool'] ? String(step['tool']) : undefined,
    }))
    .slice(0, 12);
}

/* ── CRUD ─────────────────────────────────────────────────────────────────── */

export type SaveAgentInput = {
  id?: string;
  name: string;
  description?: string;
  prompt: string;
  instructions: string;
  trigger: AgentTrigger;
  toolNames: string[];
  steps: AgentStepSpec[];
  filters?: Record<string, unknown>;
  approvalPolicy: ApprovalPolicy;
  enabled?: boolean;
  runAsUserId?: string | null;
  maxRole?: Role;
};

export async function saveAgent(ctx: Ctx, input: SaveAgentInput) {
  ctxAssert(ctx, 'agent:manage');
  await ensureToolsLoaded();

  const registered = new Set(allTools().map((t) => t.name));
  const unknown = input.toolNames.filter((name) => !registered.has(name));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown tool${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }

  if (input.trigger.kind === 'schedule' && !isValidCron(input.trigger.cron)) {
    throw new ValidationError('That cron expression is not valid. Use five fields, e.g. "0 8 * * 1-5".');
  }

  // HIGH risk never auto-approves, whatever the form posted.
  const approvalPolicy: ApprovalPolicy = {
    ...input.approvalPolicy,
    autoApprove: input.approvalPolicy.autoApprove.filter((r) => r !== 'high'),
  };

  const values = {
    workspaceId: ctx.workspaceId,
    name: input.name,
    description: input.description ?? null,
    prompt: input.prompt,
    instructions: input.instructions,
    trigger: input.trigger,
    toolNames: input.toolNames,
    steps: input.steps,
    filters: input.filters ?? {},
    outputSchema: [
      { name: 'findings', type: 'string[]' as const, description: 'One line per record acted on.', required: true },
      { name: 'summary', type: 'string' as const, description: 'Short recap.', required: true },
    ],
    approvalPolicy,
    enabled: input.enabled ?? true,
    // The agent acts as whoever authorised it, clamped to `maxRole` at run time.
    runAsUserId: input.runAsUserId ?? ctx.userId,
    maxRole: input.maxRole ?? 'member',
    nextRunAt: input.trigger.kind === 'schedule' ? nextRunFor(input.trigger.cron) : null,
  };

  if (input.id) {
    const [existing] = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(scope(ctx, agents), eq(agents.id, input.id)))
      .limit(1);
    if (!existing) throw new NotFoundError('Agent', input.id);

    await ctx.db
      .update(agents)
      .set(values)
      .where(and(scope(ctx, agents), eq(agents.id, input.id)));

    await record(ctx, {
      action: 'agent.updated',
      resourceType: 'agent',
      resourceId: input.id,
      riskLevel: 'medium',
      metadata: { name: input.name, tools: input.toolNames.length },
    });
    return input.id;
  }

  const [created] = await ctx.db
    .insert(agents)
    .values({ ...values, createdById: ctx.userId })
    .returning({ id: agents.id });

  await record(ctx, {
    action: 'agent.created',
    resourceType: 'agent',
    resourceId: created!.id,
    riskLevel: 'medium',
    metadata: { name: input.name, tools: input.toolNames },
  });

  return created!.id;
}

export async function setAgentEnabled(ctx: Ctx, agentId: string, enabled: boolean) {
  ctxAssert(ctx, 'agent:manage');
  await ctx.db
    .update(agents)
    .set({ enabled })
    .where(and(scope(ctx, agents), eq(agents.id, agentId)));

  await record(ctx, {
    action: enabled ? 'agent.enabled' : 'agent.disabled',
    resourceType: 'agent',
    resourceId: agentId,
    riskLevel: 'medium',
  });
}

export async function deleteAgent(ctx: Ctx, agentId: string) {
  ctxAssert(ctx, 'agent:manage');
  await ctx.db
    .update(agents)
    .set({ deletedAt: new Date(), enabled: false })
    .where(and(scope(ctx, agents), eq(agents.id, agentId)));

  await record(ctx, {
    action: 'agent.deleted',
    resourceType: 'agent',
    resourceId: agentId,
    riskLevel: 'high',
  });
}

export async function listAgents(ctx: Ctx) {
  return ctx.db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      trigger: agents.trigger,
      toolNames: agents.toolNames,
      enabled: agents.enabled,
      lastRunAt: agents.lastRunAt,
      nextRunAt: agents.nextRunAt,
      approvalPolicy: agents.approvalPolicy,
      runAsName: users.name,
      runCount: sql<number>`(
        SELECT count(*)::int FROM agent_runs r WHERE r.agent_id = ${agents.id}
      )`,
      failureCount: sql<number>`(
        SELECT count(*)::int FROM agent_runs r WHERE r.agent_id = ${agents.id} AND r.status = 'failed'
      )`,
      pendingApprovals: sql<number>`(
        SELECT count(*)::int FROM approvals a WHERE a.agent_id = ${agents.id} AND a.status = 'pending'
      )`,
    })
    .from(agents)
    .leftJoin(users, eq(users.id, agents.runAsUserId))
    .where(scope(ctx, agents))
    .orderBy(desc(agents.enabled), agents.name);
}

export async function getAgent(ctx: Ctx, agentId: string) {
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(and(scope(ctx, agents), eq(agents.id, agentId)))
    .limit(1);
  if (!agent) throw new NotFoundError('Agent', agentId);

  const [runs, pending, teamMembers] = await Promise.all([
    ctx.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        summary: agentRuns.summary,
        triggerKind: agentRuns.triggerKind,
        startedAt: agentRuns.startedAt,
        finishedAt: agentRuns.finishedAt,
        latencyMs: agentRuns.latencyMs,
        stepCount: agentRuns.stepCount,
        promptTokens: agentRuns.promptTokens,
        completionTokens: agentRuns.completionTokens,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(scoped(ctx, agentRuns, eq(agentRuns.agentId, agentId)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(25),

    ctx.db
      .select()
      .from(approvals)
      .where(scoped(ctx, approvals, eq(approvals.agentId, agentId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.createdAt)),

    ctx.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(sql`workspace_members wm`, sql`wm.user_id = ${users.id}`)
      .where(sql`wm.workspace_id = ${ctx.workspaceId} AND wm.status = 'active'`)
      .orderBy(users.name),
  ]);

  return { agent, runs, pendingApprovals: pending, teamMembers };
}

/** Available tools, described for the builder UI. */
export async function toolCatalogue(): Promise<
  { name: string; description: string; risk: string; readOnly: boolean; permission: string }[]
> {
  await ensureToolsLoaded();
  return allTools()
    .map((tool: RegisteredTool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      readOnly: tool.readOnly,
      permission: tool.permission,
    }))
    .sort((a, b) => Number(b.readOnly) - Number(a.readOnly) || a.name.localeCompare(b.name));
}

/**
 * Next fire time for a cron expression.
 *
 * Minute-granularity scan over the next 366 days. Deliberately simple: agents
 * run on human schedules (a few times a day at most), so a full cron library
 * would be more surface area than the problem needs.
 */
export function nextRunFor(cron: string, from = new Date()): Date | null {
  if (!isValidCron(cron)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/) as [
    string,
    string,
    string,
    string,
    string,
  ];

  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from.getTime() + 366 * 86_400_000);
  while (cursor <= limit) {
    if (
      matchesField(minute, cursor.getUTCMinutes()) &&
      matchesField(hour, cursor.getUTCHours()) &&
      matchesField(dayOfMonth, cursor.getUTCDate()) &&
      matchesField(month, cursor.getUTCMonth() + 1) &&
      matchesField(dayOfWeek, cursor.getUTCDay())
    ) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function matchesField(field: string, value: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepRaw] = part.split('/');
      const step = Number(stepRaw);
      if (!Number.isFinite(step) || step <= 0) continue;
      if (range === '*' || range === undefined) {
        if (value % step === 0) return true;
        continue;
      }
      const [start, end] = range.split('-').map(Number);
      if (
        start != null &&
        Number.isFinite(start) &&
        value >= start &&
        (end == null || !Number.isFinite(end) || value <= end) &&
        (value - start) % step === 0
      ) {
        return true;
      }
      continue;
    }

    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (start != null && end != null && value >= start && value <= end) return true;
      continue;
    }

    if (Number(part) === value) return true;
  }
  return false;
}

export function describeTrigger(trigger: AgentTrigger): string {
  if (trigger.kind === 'manual') return 'Runs when you click Run';
  if (trigger.kind === 'webhook') return 'Runs on an inbound webhook';
  if (trigger.kind === 'event') return `Runs on ${trigger.event.replace(/[._]/g, ' ')}`;
  return `Runs on schedule · ${describeCron(trigger.cron)} (${trigger.timezone})`;
}

/** Human-readable cron for the common shapes agents actually use. */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, , , dayOfWeek] = fields as [string, string, string, string, string];

  const time =
    /^\d+$/.test(hour) && /^\d+$/.test(minute)
      ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      : cron;

  if (dayOfWeek === '1-5') return `weekdays at ${time}`;
  if (dayOfWeek === '*') return `daily at ${time}`;
  if (dayOfWeek === '1') return `Mondays at ${time}`;
  if (/^\d$/.test(dayOfWeek)) {
    const days = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    return `${days[Number(dayOfWeek)]} at ${time}`;
  }
  return cron;
}
