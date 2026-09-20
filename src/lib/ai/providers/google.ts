import { env } from '@/lib/env';
import { buildSystemPrompt, fitEvidence } from '../prompt';
import {
  ModelError,
  type CompletionRequest,
  type CompletionResult,
  type JsonSchema,
  type JsonSchemaProperty,
  type LanguageModel,
  type ModelMessage,
  type StructuredRequest,
  type StructuredResult,
} from '../types';
import { coerceStructured, repairInstruction } from './structured';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Google Gemini `generateContent` adapter. */
export class GoogleModel implements LanguageModel {
  readonly provider = 'google' as const;
  readonly isRemote = true;
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    model?: string,
  ) {
    this.id = model ?? env.GOOGLE_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = buildSystemPrompt({
      operator: request.system,
      evidence: request.evidence ? fitEvidence(request.evidence, 40_000) : undefined,
    });

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toGoogleContents(request.messages),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.2,
      },
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: toGoogleSchema(t.parameters),
                })),
              },
            ],
            toolConfig: {
              functionCallingConfig: {
                mode:
                  request.toolChoice === 'required'
                    ? 'ANY'
                    : request.toolChoice === 'none'
                      ? 'NONE'
                      : 'AUTO',
              },
            },
          }
        : {}),
    };

    const json = await this.post(body);
    const parts = json.candidates?.[0]?.content?.parts ?? [];

    return {
      text: parts
        .map((p) => p.text ?? '')
        .join('\n')
        .trim(),
      toolCalls: parts
        .filter((p): p is { functionCall: { name: string; args?: Record<string, unknown> } } =>
          Boolean(p.functionCall),
        )
        .map((p, i) => ({
          // Gemini does not return call ids; synthesise stable ones for the loop.
          id: `gcall_${i}`,
          name: p.functionCall.name,
          arguments: p.functionCall.args ?? {},
        })),
      stopReason: parts.some((p) => p.functionCall)
        ? 'tool_use'
        : json.candidates?.[0]?.finishReason === 'MAX_TOKENS'
          ? 'max_tokens'
          : 'stop',
      usage: {
        promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
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
        lastError = 'No emit_result function call was produced.';
      }
      attempt += 1;
    }
    throw new ModelError(`Structured output failed: ${lastError}`, 'google', true);
  }

  private async post(body: unknown): Promise<GoogleResponse> {
    const url = `${BASE}/${this.id}:generateContent`;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      }).catch((err: Error) => err);

      if (res instanceof Error) {
        lastErr = res;
      } else if (res.ok) {
        return (await res.json()) as GoogleResponse;
      } else {
        const text = await res.text().catch(() => '');
        if (res.status === 429 || res.status >= 500) {
          lastErr = new ModelError(`Google ${res.status}: ${text.slice(0, 300)}`, 'google', true);
        } else {
          throw new ModelError(`Google ${res.status}: ${text.slice(0, 300)}`, 'google', false);
        }
      }
      await new Promise((r) => setTimeout(r, 2 ** attempt * 750 + Math.random() * 250));
    }
    throw new ModelError(lastErr?.message ?? 'Google request failed.', 'google', true);
  }
}

type GooglePart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
};

type GoogleResponse = {
  candidates?: { content?: { parts?: GooglePart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function toGoogleContents(messages: ModelMessage[]) {
  return messages.flatMap((msg) => {
    if (msg.role === 'system') return [];
    if (msg.role === 'tool') {
      return [
        {
          role: 'user' as const,
          parts: [
            {
              functionResponse: {
                name: msg.name,
                response: { result: msg.content },
              },
            },
          ],
        },
      ];
    }
    const parts: Record<string, unknown>[] = [];
    if (msg.content) parts.push({ text: msg.content });
    if ('toolCalls' in msg) {
      for (const call of msg.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
    }
    if (parts.length === 0) return [];
    return [{ role: msg.role === 'assistant' ? ('model' as const) : ('user' as const), parts }];
  });
}

/** Gemini uses uppercase type names and rejects `additionalProperties`. */
function toGoogleSchema(schema: JsonSchema): Record<string, unknown> {
  const convert = (prop: JsonSchemaProperty): Record<string, unknown> => {
    const out: Record<string, unknown> = { type: prop.type.toUpperCase() };
    if (prop.description) out['description'] = prop.description;
    if (prop.enum) out['enum'] = [...prop.enum];
    if (prop.items) out['items'] = convert(prop.items);
    if (prop.properties) {
      out['properties'] = Object.fromEntries(
        Object.entries(prop.properties).map(([k, v]) => [k, convert(v)]),
      );
      if (prop.required) out['required'] = prop.required;
    }
    return out;
  };

  return {
    type: 'OBJECT',
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, convert(v)]),
    ),
    ...(schema.required ? { required: schema.required } : {}),
  };
}
