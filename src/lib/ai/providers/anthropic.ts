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
    this.id = model ?? env.ANTHROPIC_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = buildSystemPrompt({
      operator: request.system,
      evidence: request.evidence ? fitEvidence(request.evidence, 40_000) : undefined,
    });

    const body = {
      model: this.id,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.2,
      system,
      messages: toAnthropicMessages(request.messages),
      ...(request.tools?.length
        ? {
            tools: request.tools.map(toAnthropicTool),
            tool_choice:
              request.toolChoice === 'required'
                ? { type: 'any' as const }
                : request.toolChoice === 'none'
                  ? { type: 'none' as const }
                  : { type: 'auto' as const },
          }
        : {}),
    };

    const json = await this.post(body);
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
      if (call) {
        const coerced = coerceStructured<T>(call.arguments, request);
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
