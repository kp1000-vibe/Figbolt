import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agentRunSteps,
  agentRuns,
  agents,
  notifications,
  workspaceMembers,
  workspaces,
  type Role,
  type SourceRef,
} from '@/db/schema';
import { getModelForTask } from '@/lib/ai';
import type { ModelMessage, ToolCall, ToolDefinition } from '@/lib/ai/types';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import { getTool } from '@/lib/agents/registry';
import { effectiveAgentRole } from '@/lib/security/permissions';
import { agentCtx, scope, scoped, ValidationError, type Ctx } from '../context';
import { record } from '../audit';

/**
 * The agent execution loop.
 *
 *   trigger → build context → plan → select tool → execute → evaluate
 *           → request approval when required → act → audit → update memory
 *
 * Two properties this is built around:
 *
 *  - **Observable.** Every plan, tool call, argument, result and approval is
 *    persisted as an `agent_run_steps` row, so the run page can show exactly
 *    what happened rather than a summary of what was supposed to happen.
 *  - **Bounded.** Step count, wall clock and token spend are all capped, and
 *    an agent's effective role is clamped to its authorizing user's *current*
 *    role on every run — so revoking a person's access immediately constrains
 *    the agents they created.
 */

const MAX_STEPS_DEFAULT = 12;
const MAX_RUNTIME_MS = 120_000;

export type RunTrigger = {
  kind: 'manual' | 'schedule' | 'event' | 'webhook';
  detail?: string;
  input?: Record<string, unknown>;
};

export type RunOutcome = {
  runId: string;
  status: 'succeeded' | 'failed' | 'awaiting_approval' | 'cancelled';
  summary: string;
  output: Record<string, unknown> | null;
  sources: SourceRef[];
  pendingApprovals: string[];
  steps: number;
  latencyMs: number;
};

export async function runAgent(ctx: Ctx, agentId: string, trigger: RunTrigger): Promise<RunOutcome> {
  await ensureToolsLoaded();
  const startedAt = Date.now();

  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(and(scope(ctx, agents), eq(agents.id, agentId)))
    .limit(1);
  if (!agent) throw new ValidationError('That agent does not exist in this workspace.');
  if (!agent.enabled) throw new ValidationError(`Agent "${agent.name}" is disabled.`);

  /* Clamp authority: min(agent ceiling, current role of the run-as user). */
  const runAsRole = await resolveRunAsRole(ctx, agent.runAsUserId);
  const role = effectiveAgentRole(agent.maxRole, runAsRole);

  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      workspaceId: ctx.workspaceId,
      agentId: agent.id,
      status: 'running',
      triggerKind: trigger.kind,
      triggerDetail: trigger.detail ?? null,
      triggeredById: ctx.userId,
      input: trigger.input ?? null,
      startedAt: new Date(),
    })
    .returning();

  const runId = run!.id;

  if (!role) {
    return finishRun(ctx, runId, {
      status: 'failed',
      summary:
        'The user this agent runs as no longer has access to this workspace. Reassign the agent before running it again.',
      error: 'RUN_AS_USER_INACTIVE',
      startedAt,
      sources: [],
      pendingApprovals: [],
      steps: 0,
    });
  }

  const scopedCtx = agentCtx(
    { ...ctx, userId: agent.runAsUserId ?? ctx.userId },
    { id: agent.id, name: agent.name },
    role,
    runId,
  );

  const maxSteps = await resolveMaxSteps(ctx, agent.id);
  const tools = resolveTools(agent.toolNames);

  if (tools.length === 0) {
    return finishRun(scopedCtx, runId, {
      status: 'failed',
      summary: 'This agent has no usable tools configured.',
      error: 'NO_TOOLS',
      startedAt,
      sources: [],
      pendingApprovals: [],
      steps: 0,
    });
  }

  // Jev picks the model once for the whole run: a tool-calling conversation
  // must not change provider between steps.
  const { model } = await getModelForTask({ usesTools: true });
  const workspaceContext = await loadWorkspaceContext(ctx);
  const sources: SourceRef[] = [];
  const pendingApprovals: string[] = [];
  let stepIndex = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: buildTaskMessage(agent, trigger),
    },
  ];

  await writeStep(scopedCtx, runId, stepIndex++, {
    kind: 'plan',
    title: 'Plan',
    input: { instructions: agent.instructions.slice(0, 2000), trigger: trigger.kind },
    output: { steps: agent.steps.map((s) => s.title) },
    status: 'ok',
  });

  try {
    while (stepIndex < maxSteps) {
      if (Date.now() - startedAt > MAX_RUNTIME_MS) {
        await writeStep(scopedCtx, runId, stepIndex++, {
          kind: 'error',
          title: 'Time limit reached',
          status: 'error',
          error: `Run exceeded ${MAX_RUNTIME_MS / 1000}s.`,
        });
        break;
      }

      const modelStarted = Date.now();
      const completion = await model.complete({
        system: buildSystemPrompt(agent, workspaceContext),
        messages,
        tools: tools.map(toModelTool),
        toolChoice: 'auto',
        maxTokens: 2000,
        temperature: 0.2,
      });

      promptTokens += completion.usage.promptTokens;
      completionTokens += completion.usage.completionTokens;

      await writeStep(scopedCtx, runId, stepIndex++, {
        kind: 'model_call',
        title: completion.toolCalls.length > 0 ? 'Chose tools' : 'Produced result',
        output: {
          toolCalls: completion.toolCalls.map((c) => c.name),
          text: completion.text.slice(0, 1500),
        },
        status: 'ok',
        latencyMs: Date.now() - modelStarted,
        promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens,
      });

      /* No tool calls: the agent is done and `text` is its answer. */
      if (completion.toolCalls.length === 0) {
        const summary = completion.text.trim() || 'The agent completed without producing a summary.';
        return finishRun(scopedCtx, runId, {
          status: pendingApprovals.length > 0 ? 'awaiting_approval' : 'succeeded',
          summary,
          output: { summary, findings: extractFindings(completion.text) },
          startedAt,
          sources,
          pendingApprovals,
          steps: stepIndex,
          promptTokens,
          completionTokens,
          model: completion.model,
        });
      }

      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });

      for (const call of completion.toolCalls) {
        if (stepIndex >= maxSteps) break;
        const outcome = await executeCall(scopedCtx, {
          call,
          agent,
          runId,
          stepIndex: stepIndex++,
          allowList: agent.toolNames,
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: outcome.content,
          isError: outcome.isError,
        });

        if (outcome.sources) sources.push(...outcome.sources);
        if (outcome.approvalId) pendingApprovals.push(outcome.approvalId);
      }
    }

    /* Step budget exhausted — summarise honestly rather than pretending. */
    const summary =
      pendingApprovals.length > 0
        ? `Prepared ${pendingApprovals.length} action${pendingApprovals.length === 1 ? '' : 's'} for your approval.`
        : `Reached the ${maxSteps}-step limit before finishing. Partial findings are in the step log.`;

    return finishRun(scopedCtx, runId, {
      status: pendingApprovals.length > 0 ? 'awaiting_approval' : 'succeeded',
      summary,
      output: { summary },
      startedAt,
      sources,
      pendingApprovals,
      steps: stepIndex,
      promptTokens,
      completionTokens,
    });
  } catch (err) {
    console.error(`[agent] run ${runId} failed:`, err);
    await writeStep(scopedCtx, runId, stepIndex++, {
      kind: 'error',
      title: 'Run failed',
      status: 'error',
      error: (err as Error).message.slice(0, 500),
    });
    return finishRun(scopedCtx, runId, {
      status: 'failed',
      summary: `The run failed: ${(err as Error).message.slice(0, 200)}`,
      error: (err as Error).message.slice(0, 1000),
      startedAt,
      sources,
      pendingApprovals,
      steps: stepIndex,
      promptTokens,
      completionTokens,
    });
  }
}

/* ── Tool execution ───────────────────────────────────────────────────────── */

type CallOutcome = {
  content: string;
  isError: boolean;
  sources?: SourceRef[];
  approvalId?: string;
};

async function executeCall(
  ctx: Ctx,
  args: { call: ToolCall; agent: typeof agents.$inferSelect; runId: string; stepIndex: number; allowList: string[] },
): Promise<CallOutcome> {
  const { call, agent, runId, stepIndex } = args;
  const started = Date.now();

  const stepId = await writeStep(ctx, runId, stepIndex, {
    kind: 'tool_call',
    title: `${call.name}`,
    tool: call.name,
    input: call.arguments,
    status: 'ok',
    riskLevel: getTool(call.name)?.risk ?? 'low',
  });

  const outcome = await dispatchTool(ctx, call.name, call.arguments, {
    allowList: args.allowList,
    autoApprove: agent.approvalPolicy.autoApprove,
    agentId: agent.id,
    runId,
    stepId,
    requestedForId: agent.runAsUserId ?? ctx.userId,
    rationale: `Proposed by agent "${agent.name}" during run ${runId}.`,
    approvalExpiryHours: agent.approvalPolicy.expiresAfterHours,
  });

  if (outcome.status === 'ok') {
    await ctx.db
      .update(agentRunSteps)
      .set({
        output: truncateForStorage(outcome.result.data),
        status: 'ok',
        latencyMs: Date.now() - started,
        sources: outcome.result.sources ?? [],
      })
      .where(eq(agentRunSteps.id, stepId));

    return {
      content: renderToolResult(outcome.result.summary, outcome.result.data),
      isError: false,
      sources: outcome.result.sources,
    };
  }

  if (outcome.status === 'needs_approval') {
    await ctx.db
      .update(agentRunSteps)
      .set({
        status: 'awaiting_approval',
        output: { approvalId: outcome.approvalId, title: outcome.title } as never,
        latencyMs: Date.now() - started,
      })
      .where(eq(agentRunSteps.id, stepId));

    return {
      // The model must know the action did *not* happen, or it will report it
      // as done in its summary.
      content: `This action was NOT performed. It has been queued for human approval (id ${outcome.approvalId}). Continue with other work, and describe it as "awaiting approval" in your summary.`,
      isError: false,
      approvalId: outcome.approvalId,
    };
  }

  await ctx.db
    .update(agentRunSteps)
    .set({ status: 'error', error: outcome.error, latencyMs: Date.now() - started })
    .where(eq(agentRunSteps.id, stepId));

  return { content: `Tool error (${outcome.code}): ${outcome.error}`, isError: true };
}

/* ── Prompt construction ──────────────────────────────────────────────────── */

function buildSystemPrompt(agent: typeof agents.$inferSelect, workspaceContext: string): string {
  return [
    agent.instructions.trim(),
    '',
    'HOW YOU WORK:',
    '- Use tools to gather real records before drawing any conclusion.',
    '- Never state a fact about a customer that a tool result did not give you.',
    '- Actions that change data or reach a customer may be held for human approval.',
    '  If a tool tells you an action is awaiting approval, it has NOT happened — say so.',
    '- When you have what you need, reply with your findings in plain text and stop calling tools.',
    '- Be concise. Name specific records, amounts and dates.',
    '',
    workspaceContext ? `WORKSPACE CONTEXT (trusted):\n${workspaceContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildTaskMessage(agent: typeof agents.$inferSelect, trigger: RunTrigger): string {
  const filters = agent.filters ?? {};
  const filterLines = Object.entries(filters)
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  return [
    `Run the agent "${agent.name}".`,
    '',
    `Original request: ${agent.prompt}`,
    filterLines ? `\nConfigured filters:\n${filterLines}` : '',
    trigger.input && Object.keys(trigger.input).length > 0
      ? `\nTrigger payload:\n${JSON.stringify(trigger.input).slice(0, 1500)}`
      : '',
    `\nToday is ${new Date().toISOString().slice(0, 10)}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveTools(names: string[]): ToolDefinitionLike[] {
  return names
    .map((name) => getTool(name))
    .filter((t): t is NonNullable<ReturnType<typeof getTool>> => Boolean(t));
}

type ToolDefinitionLike = NonNullable<ReturnType<typeof getTool>>;

function toModelTool(tool: ToolDefinitionLike): ToolDefinition {
  return {
    name: tool.name,
    description: `${tool.description}${tool.readOnly ? '' : ` (${tool.risk.toUpperCase()} RISK — may require approval)`}`,
    parameters: tool.parameters,
  };
}

/* ── Persistence ──────────────────────────────────────────────────────────── */

async function writeStep(
  ctx: Ctx,
  runId: string,
  index: number,
  step: {
    kind: 'plan' | 'retrieve' | 'tool_call' | 'model_call' | 'approval' | 'result' | 'error';
    title: string;
    tool?: string;
    input?: unknown;
    output?: unknown;
    status?: 'ok' | 'error' | 'skipped' | 'awaiting_approval' | 'denied';
    error?: string;
    riskLevel?: 'low' | 'medium' | 'high';
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
  },
): Promise<string> {
  const [row] = await ctx.db
    .insert(agentRunSteps)
    .values({
      workspaceId: ctx.workspaceId,
      runId,
      index,
      kind: step.kind,
      title: step.title,
      tool: step.tool ?? null,
      input: truncateForStorage(step.input),
      output: truncateForStorage(step.output),
      status: step.status ?? 'ok',
      error: step.error ?? null,
      riskLevel: step.riskLevel ?? null,
      latencyMs: step.latencyMs ?? null,
      promptTokens: step.promptTokens ?? null,
      completionTokens: step.completionTokens ?? null,
      startedAt: new Date(),
    })
    .returning({ id: agentRunSteps.id });
  return row!.id;
}

async function finishRun(
  ctx: Ctx,
  runId: string,
  input: {
    status: RunOutcome['status'];
    summary: string;
    output?: Record<string, unknown> | null;
    error?: string;
    startedAt: number;
    sources: SourceRef[];
    pendingApprovals: string[];
    steps: number;
    promptTokens?: number;
    completionTokens?: number;
    model?: string;
  },
): Promise<RunOutcome> {
  const latencyMs = Date.now() - input.startedAt;
  const dedupedSources = dedupeSources(input.sources);

  await ctx.db
    .update(agentRuns)
    .set({
      status: input.status,
      summary: input.summary,
      output: input.output ?? null,
      sources: dedupedSources,
      error: input.error ?? null,
      finishedAt: new Date(),
      latencyMs,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      stepCount: input.steps,
      model: input.model ?? null,
    })
    .where(and(scope(ctx, agentRuns), eq(agentRuns.id, runId)));

  const [runRow] = await ctx.db
    .select({ agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(and(scope(ctx, agentRuns), eq(agentRuns.id, runId)))
    .limit(1);

  if (runRow) {
    await ctx.db
      .update(agents)
      .set({ lastRunAt: new Date() })
      .where(and(scope(ctx, agents), eq(agents.id, runRow.agentId)));
  }

  // Surface finished runs in the Inbox, except quiet successes with nothing to
  // decide — those would be pure noise.
  const worthNotifying = input.status !== 'succeeded' || input.pendingApprovals.length > 0;
  if (worthNotifying && ctx.userId) {
    await ctx.db
      .insert(notifications)
      .values({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        kind: input.status === 'failed' ? 'automation_error' : 'needs_attention',
        title: `${ctx.actor.label}: ${input.status.replace('_', ' ')}`,
        whatHappened: input.summary.slice(0, 500),
        whyItMatters:
          input.status === 'failed'
            ? 'The agent could not complete its work, so nothing was acted on.'
            : `${input.pendingApprovals.length} proposed action(s) are waiting on you.`,
        recommendedAction: { label: 'Open run', kind: 'open_run', payload: { runId } },
        severity: input.status === 'failed' ? 'warning' : 'info',
        runId,
        dedupeKey: `run:${runId}`,
      })
      .onConflictDoNothing();
  }

  await record(ctx, {
    action: `agent.run_${input.status}`,
    resourceType: 'agent_run',
    resourceId: runId,
    riskLevel: 'low',
    metadata: {
      steps: input.steps,
      latencyMs,
      approvals: input.pendingApprovals.length,
      tokens: (input.promptTokens ?? 0) + (input.completionTokens ?? 0),
    },
  });

  return {
    runId,
    status: input.status,
    summary: input.summary,
    output: input.output ?? null,
    sources: dedupedSources,
    pendingApprovals: input.pendingApprovals,
    steps: input.steps,
    latencyMs,
  };
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function resolveRunAsRole(ctx: Ctx, runAsUserId: string | null): Promise<Role | null> {
  if (!runAsUserId) return ctx.role;
  const [membership] = await ctx.db
    .select({ role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, runAsUserId)),
    )
    .limit(1);
  if (!membership || membership.status !== 'active') return null;
  return membership.role;
}

async function resolveMaxSteps(ctx: Ctx, _agentId: string): Promise<number> {
  const [ws] = await ctx.db
    .select({ aiSettings: workspaces.aiSettings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  const configured = ws?.aiSettings?.maxStepsPerRun ?? MAX_STEPS_DEFAULT;
  return Math.max(3, Math.min(configured, 30));
}

async function loadWorkspaceContext(ctx: Ctx): Promise<string> {
  const [ws] = await ctx.db
    .select({ name: workspaces.name, companyContext: workspaces.companyContext })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) return '';
  const c = ws.companyContext;
  return [
    `Workspace: ${ws.name}`,
    c?.whatWeSell ? `What we sell: ${c.whatWeSell}` : null,
    c?.idealCustomer ? `Ideal customer: ${c.idealCustomer}` : null,
    c?.qualificationCriteria ? `Qualified means: ${c.qualificationCriteria}` : null,
    c?.competitors?.length ? `Competitors: ${c.competitors.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderToolResult(summary: string, data: unknown): string {
  const serialised = JSON.stringify(data ?? null);
  const body = serialised.length > 6000 ? `${serialised.slice(0, 6000)}…[truncated]` : serialised;
  return `${summary}\n\n${body}`;
}

/** Keep step rows bounded — a huge payload should not bloat the run log. */
function truncateForStorage(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const serialised = JSON.stringify(value);
  if (serialised.length <= 20_000) return value;
  return { truncated: true, preview: serialised.slice(0, 20_000) };
}

function extractFindings(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-•*\d.]+\s*/, '').trim())
    .filter((line) => line.length > 15)
    .slice(0, 20);
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const source of sources) {
    const key = `${source.type}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out.slice(0, 40);
}

/* ── Queries ──────────────────────────────────────────────────────────────── */

export async function getRun(ctx: Ctx, runId: string) {
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(scope(ctx, agentRuns), eq(agentRuns.id, runId)))
    .limit(1);
  if (!run) return null;

  const [steps, [agent]] = await Promise.all([
    ctx.db
      .select()
      .from(agentRunSteps)
      .where(scoped(ctx, agentRunSteps, eq(agentRunSteps.runId, runId)))
      .orderBy(agentRunSteps.index),
    ctx.db.select().from(agents).where(and(scope(ctx, agents), eq(agents.id, run.agentId))).limit(1),
  ]);

  return { run, steps, agent: agent ?? null };
}

export async function listRuns(ctx: Ctx, options: { agentId?: string; limit?: number } = {}) {
  return ctx.db
    .select({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      agentName: agents.name,
      status: agentRuns.status,
      summary: agentRuns.summary,
      triggerKind: agentRuns.triggerKind,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      latencyMs: agentRuns.latencyMs,
      stepCount: agentRuns.stepCount,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(scoped(ctx, agentRuns, options.agentId ? eq(agentRuns.agentId, options.agentId) : undefined))
    .orderBy(desc(agentRuns.createdAt))
    .limit(options.limit ?? 40);
}
