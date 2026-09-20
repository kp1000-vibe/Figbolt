import type { JsonSchema, JsonSchemaProperty, StructuredRequest } from '../types';

/**
 * Shared post-processing for structured model output.
 *
 * Even with forced tool calls, models drop optional fields, return `"12"` where
 * a number was asked for, or wrap arrays in an object. Rather than failing the
 * whole run, coerce what is safely coercible, reject what is not, and let the
 * caller do exactly one repair round-trip with a precise error message.
 */

export type CoerceOutcome<T> =
  | { ok: true; value: T; confidence: number }
  | { ok: false; error: string };

export function coerceStructured<T>(
  raw: unknown,
  request: StructuredRequest<T>,
): CoerceOutcome<T> {
  const issues: string[] = [];
  const coerced = coerceToSchema(raw, request.schema, '$', issues);

  if (issues.length > 0) {
    return { ok: false, error: issues.slice(0, 6).join('; ') };
  }
  if (request.validate && !request.validate(coerced)) {
    return { ok: false, error: 'Result failed the caller-supplied validator.' };
  }

  return {
    ok: true,
    value: coerced as T,
    confidence: readConfidence(coerced),
  };
}

export function repairInstruction(error: string): string {
  return [
    'Your previous emit_result call did not satisfy the schema.',
    `Problem: ${error}`,
    'Call emit_result again with a corrected argument. Change only what is needed.',
  ].join('\n');
}

/** Many schemas carry a `confidence` field; fall back to a neutral prior. */
function readConfidence(value: unknown): number {
  if (value && typeof value === 'object' && 'confidence' in value) {
    const c = Number((value as { confidence: unknown }).confidence);
    if (Number.isFinite(c)) return Math.min(1, Math.max(0, c > 1 ? c / 100 : c));
  }
  return 0.7;
}

function coerceToSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    const present = key in input && input[key] !== null && input[key] !== undefined;
    const required = schema.required?.includes(key) ?? false;

    if (!present) {
      if (required) {
        // Prefer a well-typed empty value over a hard failure for containers;
        // a missing scalar is a real problem worth a repair pass.
        const filled = emptyFor(prop);
        if (filled === undefined) issues.push(`${path}.${key} is required`);
        else out[key] = filled;
      }
      continue;
    }
    out[key] = coerceProp(input[key], prop, `${path}.${key}`, issues);
  }
  return out;
}

function coerceProp(
  value: unknown,
  prop: JsonSchemaProperty,
  path: string,
  issues: string[],
): unknown {
  switch (prop.type) {
    case 'string': {
      const s = typeof value === 'string' ? value : String(value);
      if (prop.enum && !prop.enum.includes(s)) {
        // Case-insensitive rescue before giving up on an enum.
        const match = prop.enum.find((e) => e.toLowerCase() === s.toLowerCase().trim());
        if (match) return match;
        issues.push(`${path} must be one of ${prop.enum.join(' | ')} (got "${s.slice(0, 40)}")`);
        return prop.enum[0];
      }
      return s;
    }
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s%]/g, ''));
      if (!Number.isFinite(n)) {
        issues.push(`${path} must be a number (got "${String(value).slice(0, 40)}")`);
        return 0;
      }
      return prop.type === 'integer' ? Math.round(n) : n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return Boolean(value);
    case 'array': {
      const arr = Array.isArray(value) ? value : [value];
      const items = prop.items;
      return items ? arr.map((v, i) => coerceProp(v, items, `${path}[${i}]`, issues)) : arr;
    }
    case 'object': {
      if (!prop.properties) return value;
      return coerceToSchema(
        value,
        { type: 'object', properties: prop.properties, required: prop.required },
        path,
        issues,
      );
    }
    default:
      return value;
  }
}

function emptyFor(prop: JsonSchemaProperty): unknown {
  if (prop.type === 'array') return [];
  if (prop.type === 'object') return {};
  return undefined;
}

/* ── Schema authoring helpers ─────────────────────────────────────────────── */

export const s = {
  object(properties: Record<string, JsonSchemaProperty>, required?: string[]): JsonSchema {
    return { type: 'object', properties, required, additionalProperties: false };
  },
  string(description: string): JsonSchemaProperty {
    return { type: 'string', description };
  },
  enum<const T extends readonly string[]>(values: T, description: string): JsonSchemaProperty {
    return { type: 'string', enum: values, description };
  },
  number(description: string): JsonSchemaProperty {
    return { type: 'number', description };
  },
  integer(description: string): JsonSchemaProperty {
    return { type: 'integer', description };
  },
  boolean(description: string): JsonSchemaProperty {
    return { type: 'boolean', description };
  },
  array(items: JsonSchemaProperty, description: string): JsonSchemaProperty {
    return { type: 'array', items, description };
  },
  strings(description: string): JsonSchemaProperty {
    return { type: 'array', items: { type: 'string' }, description };
  },
  nested(
    properties: Record<string, JsonSchemaProperty>,
    description: string,
    required?: string[],
  ): JsonSchemaProperty {
    return { type: 'object', properties, required, description };
  },
};
