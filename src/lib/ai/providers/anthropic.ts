import { env } from '@/lib/env';
import { buildSystemPrompt, fitEvidence } from '../prompt';
import {
  ModelError,
  type CompletionRequest,
  type CompletionResult,
  type LanguageModel,
  type ModelMessage,
  type StructuredRequest,
  type StructuredResult,
  type ToolDefinition,
} from '../types';
import { coerceStructured, repairInstruction } from './structured';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

/**
 * Anthropic model IDs never contain a dot — `claude-opus-5-5`, not
 * `claude-opus-5.5` — but the dotted form is how the versions are written
 * everywhere else, so it is the natural thing to type into an env var. The API
 * answers it with a 404 on every request, which made Ask Bolt fail outright.
 * Only digit.digit is rewritten; nothing else about the ID is guessed at.
 */
export function normalizeAnthropicModelId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('claude-') ? trimmed.replace(/(\d)\.(\d)/g, '$1-$2') : trimmed;
}

/**
 * Request options a model has refused, learned from the API's own 400 and
 * remembered per process, so only the first request to such a model pays for
 * the extra round trip.
 *
 * Newer models reject options older ones required: a forced tool choice
 * (`any` / `tool`) and `temperature`. Hard-coding which model refuses what
 * would go stale with every release; asking the API once does not.
 */
type Refusable = 'forced_tool_choice' | 'temperature';
const REFUSED = new Map<string, Set<Refusable>>();

function refuses(model: string, option: Refusable): boolean {
  return REFUSED.get(model)?.has(option) ?? false;
}

function remember(model: string, option: Refusable): void {
  const set = REFUSED.get(model) ?? new Set<Refusable>();
  set.add(option);
  REFUSED.set(model, set);
}

/** Which option, if any, a 400 is refusing. Anything else is a real error. */
export function refusedOption(status: number, text: string): Refusable | null {
  if (status !== 400) return null;
  if (/tool_choice/i.test(text) && /not supported/i.test(text)) return 'forced_tool_choice';
  if (/`?temperature`?/i.test(text) && /(deprecated|not supported|unsupported)/i.test(text)) return 'temperature';
  return null;
}

/** Test hook: forget what was learned, so each test starts from a clean model. */
export function resetLearnedRefusals(): void {
  REFUSED.clear();
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Anthropic Messages API adapter. Uses `fetch` directly — no SDK pin to drift. */
export class AnthropicModel implements LanguageModel {
  readonly provider = 'anthropic' as const;
  readonly isRemote = true;
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    model?: string,
  ) {
    this.id = normalizeAnthropicModelId(model ?? env.ANTHROPIC_MODEL);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const forced = request.toolChoice === 'required' && !refuses(this.id, 'forced_tool_choice');
    // A tool the caller requires but the model will not be forced into is
    // only offered, so say plainly that it is the way to answer. Decided here,
    // per request, so it also applies to the retry right after a refusal.
    const mustUseTool =
      request.toolChoice === 'required' && !forced && request.tools?.length
        ? `Answer by calling the ${request.tools.map((t) => t.name).join(' or ')} tool. Do not answer in prose.`
        : null;

    const system = buildSystemPrompt({
      operator: [request.system, mustUseTool].filter(Boolean).join('\n\n'),
      evidence: request.evidence ? fitEvidence(request.evidence, 40_000) : undefined,
    });

    const body = {
      model: this.id,
      max_tokens: request.maxTokens ?? 4096,
      ...(refuses(this.id, 'temperature') ? {} : { temperature: request.temperature ?? 0.2 }),
      system,
      messages: toAnthropicMessages(request.messages),
      ...(request.tools?.length
        ? {
            tools: request.tools.map(toAnthropicTool),
            tool_choice:
              forced
                ? { type: 'any' as const }
                : request.toolChoice === 'none'
                  ? { type: 'none' as const }
                  : { type: 'auto' as const },
          }
        : {}),
    };

    let json: AnthropicResponse;
    try {
      json = await this.post(body);
    } catch (err) {
      // The model refused an option. Remember that and ask once more without
      // it. A refused tool choice falls back to the tool being offered rather
      // than forced — the caller still validates whatever comes back, so
      // nothing unchecked gets through. Refusing the same option twice would
      // mean the detection is wrong, so that is surfaced, not looped on.
      if (err instanceof OptionRefused && !refuses(this.id, err.option)) {
        remember(this.id, err.option);
        return this.complete(request);
      }
      throw err;
    }
    const blocks = (json.content ?? []) as AnthropicBlock[];

    return {
      text: blocks
        .filter((b): b is Extract<AnthropicBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim(),
      toolCalls: blocks
        .filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} })),
      stopReason: json.stop_reason === 'tool_use' ? 'tool_use' : json.stop_reason === 'max_tokens' ? 'max_tokens' : 'stop',
      usage: {
        promptTokens: json.usage?.input_tokens ?? 0,
        completionTokens: json.usage?.output_tokens ?? 0,
      },
      model: this.id,
    };
  }

  /**
   * Structured output via a single forced tool call whose input schema is the
   * target shape. More reliable than asking for JSON in prose, and identical in
   * spirit across all three hosted providers.
   */
  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const emit: ToolDefinition = {
      name: 'emit_result',
      description: 'Return the result. This is the only way to answer.',
      parameters: request.schema,
    };

    const messages: ModelMessage[] = [{ role: 'user', content: request.instruction }];
    let attempt = 0;
    let lastError = '';

    while (attempt < 2) {
      const result = await this.complete({
        system: request.system,
        messages:
          attempt === 0
            ? messages
            : [...messages, { role: 'user', content: repairInstruction(lastError) }],
        tools: [emit],
        toolChoice: 'required',
        evidence: request.evidence,
        maxTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.1,
      });

      const call = result.toolCalls.find((c) => c.name === 'emit_result');
      // Without a forced tool choice a model may answer with the JSON as text
      // instead of calling the tool. Same schema, same validation.
      const args = call?.arguments ?? jsonObjectFromText(result.text);
      if (args) {
        const coerced = coerceStructured<T>(args, request);
        if (coerced.ok) {
          return {
            value: coerced.value,
            usage: result.usage,
            model: this.id,
            confidence: coerced.confidence,
          };
        }
        lastError = coerced.error;
      } else {
        lastError = 'No emit_result tool call was produced.';
      }
      attempt += 1;
    }

    throw new ModelError(`Structured output failed: ${lastError}`, 'anthropic', true);
  }

  private async post(body: unknown): Promise<AnthropicResponse> {
    let lastErr: Error | null = null;

    // Retry only on transient classes; a 400 will never become a 200.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      }).catch((err: Error) => err);

      if (res instanceof Error) {
        lastErr = res;
      } else if (res.ok) {
        return (await res.json()) as AnthropicResponse;
      } else {
        const text = await res.text().catch(() => '');
        const refused = refusedOption(res.status, text);
        if (refused) throw new OptionRefused(refused, text.slice(0, 300));
        if (res.status === 429 || res.status >= 500) {
          lastErr = new ModelError(`Anthropic ${res.status}: ${text.slice(0, 300)}`, 'anthropic', true);
        } else {
          throw new ModelError(`Anthropic ${res.status}: ${text.slice(0, 300)}`, 'anthropic', false);
        }
      }

      await new Promise((r) => setTimeout(r, 2 ** attempt * 750 + Math.random() * 250));
    }
    throw new ModelError(lastErr?.message ?? 'Anthropic request failed.', 'anthropic', true);
  }
}

class OptionRefused extends ModelError {
  constructor(
    readonly option: Refusable,
    detail: string,
  ) {
    super(`Anthropic 400: ${detail}`, 'anthropic', false);
  }
}

/** The first top-level JSON object in a text answer, tolerating a ```json fence. */
function jsonObjectFromText(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type AnthropicResponse = {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function toAnthropicTool(tool: ToolDefinition) {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function toAnthropicMessages(messages: ModelMessage[]) {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      // Anthropic carries tool results on a user turn; merge consecutive ones.
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    const blocks: AnthropicBlock[] = [];
    if (msg.content) blocks.push({ type: 'text', text: msg.content });
    if ('toolCalls' in msg) {
      for (const call of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
    }
    if (blocks.length > 0) out.push({ role: msg.role, content: blocks });
  }
  return out;
}
