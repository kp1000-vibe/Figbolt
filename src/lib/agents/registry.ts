import { z } from 'zod';
import type { JsonSchema } from '@/lib/ai/types';
import type { Permission } from '@/lib/security/permissions';
import type { RiskLevel, ApprovalPreview, SourceRef } from '@/db/schema';
import type { Ctx } from '@/server/context';

/**
 * The agent tool contract.
 *
 * This is where the security model actually lives. The model never touches the
 * database: it emits a tool *name* and *arguments*, and this registry decides
 * what happens next —
 *
 *   1. is this tool even on the agent's allow-list?
 *   2. does the effective role hold the required permission?
 *   3. does the risk class demand a human approval first?
 *   4. do the arguments validate against a Zod schema?
 *   5. only then does typed application code run, inside the caller's
 *      workspace scope, and write an audit row.
 *
 * Because every step is enforced here rather than in a prompt, a model that is
 * confused, jailbroken, or fed a malicious customer email still cannot exceed
 * what the authorizing user could do by hand in the UI.
 */

export type ToolResult = {
  /** Rendered back to the model. Keep it compact and factual. */
  summary: string;
  data: unknown;
  sources?: SourceRef[];
};

export type ToolExecuteContext = {
  ctx: Ctx;
  agentId?: string;
  runId?: string;
};

export type ToolDefinition<TInput = unknown> = {
  name: string;
  description: string;
  /** Zod schema — the single source of truth for validation. */
  input: z.ZodType<TInput>;
  /** JSON Schema handed to the model. Derived from the Zod schema below. */
  parameters: JsonSchema;
  permission: Permission;
  risk: RiskLevel;
  /**
   * Read-only tools are exempt from approval regardless of workspace policy,
   * and are safe to run inside an automation's condition evaluation.
   */
  readOnly: boolean;
  execute: (tctx: ToolExecuteContext, input: TInput) => Promise<ToolResult>;
  /**
   * Renders the exact proposed effect for the approval screen. Required for
   * every non-read-only tool: a human must see the real payload, not a
   * paraphrase of it.
   */
  preview?: (tctx: ToolExecuteContext, input: TInput) => Promise<ApprovalPreview>;
};

/**
 * Input-erased view of a tool, which is what the registry stores.
 *
 * The concrete `TInput` is only meaningful to the tool's own author. Callers
 * receive `unknown` and must go through `input.safeParse()` first — which the
 * dispatcher does — so erasing the generic here removes a variance problem
 * without weakening anything the runtime actually relies on.
 */
export type RegisteredTool = Omit<ToolDefinition<unknown>, 'input' | 'execute' | 'preview'> & {
  input: z.ZodType<unknown>;
  execute: (tctx: ToolExecuteContext, input: unknown) => Promise<ToolResult>;
  preview?: (tctx: ToolExecuteContext, input: unknown) => Promise<ApprovalPreview>;
};

/**
 * The registry outlives module re-evaluation.
 *
 * In development a hot reload re-runs `tools/read.ts` against a registry that
 * is still populated. Kept module-local, every reload would either throw on
 * duplicates or silently start from an empty map, and agent runs would break
 * until the server restarted.
 */
const globalRef = globalThis as unknown as { __figboltToolRegistry?: Map<string, RegisteredTool> };
const registry: Map<string, RegisteredTool> = (globalRef.__figboltToolRegistry ??= new Map());

export function registerTool<TInput>(tool: ToolDefinition<TInput>): void {
  if (!tool.readOnly && !tool.preview) {
    // A mutating tool with no preview could only be approved blind.
    throw new Error(`Tool "${tool.name}" mutates state and must define preview().`);
  }

  if (registry.has(tool.name)) {
    // In a production build each module is evaluated once, so a duplicate name
    // is a genuine mistake — two tools shadowing each other, one of which
    // silently never runs. In development it is almost always a hot reload.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Duplicate agent tool registration: ${tool.name}`);
    }
    registry.set(tool.name, tool as unknown as RegisteredTool);
    return;
  }

  registry.set(tool.name, tool as unknown as RegisteredTool);
}

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function allTools(): RegisteredTool[] {
  return [...registry.values()];
}

export function toolNames(): string[] {
  return [...registry.keys()].sort();
}

export function isRegistered(name: string): boolean {
  return registry.has(name);
}

/** Test seam — lets a suite install a stub tool without leaking across files. */
export function __unregister(name: string): void {
  registry.delete(name);
}

/* ── Zod → JSON Schema ────────────────────────────────────────────────────── */

/**
 * Minimal converter covering the shapes tools actually use. Keeping this in
 *-house avoids a dependency whose output would still need auditing before it
 * reached a model, and it fails loudly on anything it does not understand.
 */
export function toJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  const def = unwrap(schema);
  if (!(def instanceof z.ZodObject)) {
    throw new Error('Tool input schema must be a z.object().');
  }

  const shape = def.shape as Record<string, z.ZodType<unknown>>;
  const properties: JsonSchema['properties'] = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value);
    if (!isOptional(value)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function isOptional(schema: z.ZodType<unknown>): boolean {
  return schema.safeParse(undefined).success;
}

function unwrap(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  let current: unknown = schema;
  // Peel optional/default/nullable wrappers to reach the concrete type.
  for (let i = 0; i < 8; i++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      current = current.def.innerType;
    } else {
      break;
    }
  }
  return current as z.ZodType<unknown>;
}

function describe(schema: z.ZodType<unknown>): string {
  const meta = (schema as { description?: string }).description;
  return meta ?? '';
}

function convert(schema: z.ZodType<unknown>): JsonSchema['properties'][string] {
  const description = describe(schema);
  const inner = unwrap(schema);

  if (inner instanceof z.ZodString) return { type: 'string', description };
  if (inner instanceof z.ZodNumber) {
    return { type: inner.def.checks?.some((c) => 'kind' in c && c.kind === 'int') ? 'integer' : 'number', description };
  }
  if (inner instanceof z.ZodBoolean) return { type: 'boolean', description };
  if (inner instanceof z.ZodEnum) {
    return { type: 'string', enum: Object.values(inner.def.entries) as string[], description };
  }
  if (inner instanceof z.ZodArray) {
    return { type: 'array', items: convert(inner.element as z.ZodType<unknown>), description };
  }
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, JsonSchema['properties'][string]> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!isOptional(value)) required.push(key);
    }
    return { type: 'object', properties, required, description };
  }
  if (inner instanceof z.ZodLiteral) {
    return { type: 'string', enum: inner.def.values.map(String), description };
  }
  if (inner instanceof z.ZodUnion) {
    // Union of literals → enum; anything else falls back to a free string.
    const options = inner.def.options as z.ZodType<unknown>[];
    const literals = options.filter((o): o is z.ZodLiteral<string> => o instanceof z.ZodLiteral);
    if (literals.length === options.length) {
      return { type: 'string', enum: literals.flatMap((l) => l.def.values.map(String)), description };
    }
    return { type: 'string', description };
  }

  throw new Error(`Unsupported Zod type in tool schema: ${inner.constructor.name}`);
}

/** Convenience for declaring a tool with the JSON Schema derived automatically. */
export function defineTool<TInput>(
  spec: Omit<ToolDefinition<TInput>, 'parameters'> & { parameters?: JsonSchema },
): ToolDefinition<TInput> {
  return {
    ...spec,
    parameters: spec.parameters ?? toJsonSchema(spec.input as z.ZodType<unknown>),
  };
}
