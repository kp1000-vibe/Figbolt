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
} from '../types';
import { coerceStructured, repairInstruction } from './structured';

const API = 'https://api.openai.com/v1/chat/completions';

/** OpenAI Chat Completions adapter. */
export class OpenAiModel implements LanguageModel {
  readonly provider = 'openai' as const;
  readonly isRemote = true;
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    model?: string,
  ) {
    this.id = model ?? env.OPENAI_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = buildSystemPrompt({
      operator: request.system,
      evidence: request.evidence ? fitEvidence(request.evidence, 40_000) : undefined,
    });

    const body = {
      model: this.id,
      max_completion_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.2,
      messages: [{ role: 'system', content: system }, ...toOpenAiMessages(request.messages)],
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                strict: false,
              },
            })),
            tool_choice:
              request.toolChoice === 'required'
                ? 'required'
                : request.toolChoice === 'none'
                  ? 'none'
                  : 'auto',
          }
        : {}),
    };

    const json = await this.post(body);
    const choice = json.choices?.[0];
    const message = choice?.message;

    return {
      text: (message?.content ?? '').trim(),
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: safeParse(c.function.arguments),
      })),
      stopReason:
        choice?.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice?.finish_reason === 'length'
            ? 'max_tokens'
            : 'stop',
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
      model: this.id,
    };
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
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
        tools: [
          {
            name: 'emit_result',
            description: 'Return the result. This is the only way to answer.',
            parameters: request.schema,
          },
        ],
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
    throw new ModelError(`Structured output failed: ${lastError}`, 'openai', true);
  }

  private async post(body: unknown): Promise<OpenAiResponse> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      }).catch((err: Error) => err);

      if (res instanceof Error) {
        lastErr = res;
      } else if (res.ok) {
        return (await res.json()) as OpenAiResponse;
      } else {
        const text = await res.text().catch(() => '');
        if (res.status === 429 || res.status >= 500) {
          lastErr = new ModelError(`OpenAI ${res.status}: ${text.slice(0, 300)}`, 'openai', true);
        } else {
          throw new ModelError(`OpenAI ${res.status}: ${text.slice(0, 300)}`, 'openai', false);
        }
      }
      await new Promise((r) => setTimeout(r, 2 ** attempt * 750 + Math.random() * 250));
    }
    throw new ModelError(lastErr?.message ?? 'OpenAI request failed.', 'openai', true);
  }
}

type OpenAiResponse = {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type OpenAiOutgoing = {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
};

function toOpenAiMessages(messages: ModelMessage[]): OpenAiOutgoing[] {
  return messages.flatMap<OpenAiOutgoing>((msg) => {
    if (msg.role === 'tool') {
      return [{ role: 'tool' as const, tool_call_id: msg.toolCallId, content: msg.content }];
    }
    if (msg.role === 'assistant' && 'toolCalls' in msg) {
      return [
        {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
      ];
    }
    if (msg.role === 'system') return [];
    return [{ role: msg.role, content: msg.content }];
  });
}
