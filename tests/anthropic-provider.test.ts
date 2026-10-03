import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicModel,
  normalizeAnthropicModelId,
  refusedOption,
  resetLearnedRefusals,
} from '@/lib/ai/providers/anthropic';
import type { StructuredRequest } from '@/lib/ai/types';

/**
 * The Anthropic adapter against the ways a newer model refuses a request.
 *
 * Each of these took Ask Bolt down completely — every question returned an
 * error card — because the adapter sent options the model would not accept.
 * The fixes are runtime learning rather than a hard-coded model list, so these
 * tests drive them with the API's real error bodies.
 */

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
  required: ['answer', 'confidence'],
} as const;

const REQUEST: StructuredRequest<{ answer: string; confidence: number }> = {
  system: 'You are Bolt.',
  instruction: 'Which deals close this month?',
  schema: ANSWER_SCHEMA as unknown as StructuredRequest<unknown>['schema'],
  task: 'answer_question',
};

// Verbatim error bodies from the API.
const TOOL_CHOICE_400 =
  '{"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}';
const TEMPERATURE_400 =
  '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}';

const toolAnswer = (input: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_result', input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200 },
  );

const textAnswer = (text: string) =>
  new Response(
    JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} }),
    { status: 200 },
  );

/**
 * A fake Messages API that refuses the given options, the way the real one
 * does, and otherwise answers with `answer`.
 */
function fakeApi(refuse: { forcedTool?: boolean; temperature?: boolean }, answer: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const choice = (body.tool_choice as { type?: string } | undefined)?.type;
    if (refuse.forcedTool && (choice === 'any' || choice === 'tool')) {
      return new Response(TOOL_CHOICE_400, { status: 400 });
    }
    if (refuse.temperature && 'temperature' in body) {
      return new Response(TEMPERATURE_400, { status: 400 });
    }
    return answer();
  });
  vi.stubGlobal('fetch', spy);
  return { spy, bodies };
}

beforeEach(() => resetLearnedRefusals());
afterEach(() => vi.unstubAllGlobals());

describe('model ID', () => {
  it('turns the dotted version people type into the ID the API accepts', () => {
    expect(normalizeAnthropicModelId('claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(normalizeAnthropicModelId(' claude-sonnet-5.5 ')).toBe('claude-sonnet-5-5');
    expect(normalizeAnthropicModelId('claude-haiku-4.5')).toBe('claude-haiku-4-5');
  });

  it('leaves correct IDs, dated IDs and non-Claude IDs alone', () => {
    expect(normalizeAnthropicModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeAnthropicModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(normalizeAnthropicModelId('gpt-4.1')).toBe('gpt-4.1');
  });

  it('is what the adapter actually sends', async () => {
    const { bodies } = fakeApi({}, () => toolAnswer({ answer: 'ok', confidence: 0.9 }));
    await new AnthropicModel('test-key', 'claude-opus-5.5').completeStructured(REQUEST);
    expect(bodies[0]?.model).toBe('claude-opus-5-5');
  });
});

describe('recognising a refusal', () => {
  it('names the refused option from the real error bodies', () => {
    expect(refusedOption(400, TOOL_CHOICE_400)).toBe('forced_tool_choice');
    expect(refusedOption(400, TEMPERATURE_400)).toBe('temperature');
  });

  it('treats every other error as a real error', () => {
    expect(refusedOption(400, '{"error":{"message":"messages: field required"}}')).toBeNull();
    expect(refusedOption(404, '{"error":{"message":"model: x was not found"}}')).toBeNull();
    expect(refusedOption(500, TEMPERATURE_400)).toBeNull();
  });
});

describe('a model that refuses options', () => {
  it('answers anyway: drops the refused options, offers the tool instead of forcing it', async () => {
    const { bodies } = fakeApi({ forcedTool: true, temperature: true }, () =>
      toolAnswer({ answer: 'Acme and Atlas', confidence: 0.8 }),
    );

    const result = await new AnthropicModel('test-key', 'claude-opus-5-5').completeStructured(REQUEST);

    expect(result.value.answer).toBe('Acme and Atlas');
    const last = bodies.at(-1)!;
    expect(last).not.toHaveProperty('temperature');
    expect((last.tool_choice as { type: string }).type).toBe('auto');
    // Told plainly to use the tool, since it is no longer forced.
    expect(String(last.system)).toMatch(/emit_result/);
  });

  it('learns once: the next question goes straight to the accepted shape', async () => {
    const { spy } = fakeApi({ forcedTool: true, temperature: true }, () =>
      toolAnswer({ answer: 'ok', confidence: 0.9 }),
    );
    const model = new AnthropicModel('test-key', 'claude-opus-5-5');

    await model.completeStructured(REQUEST);
    const firstQuestionCalls = spy.mock.calls.length;
    await model.completeStructured(REQUEST);

    expect(firstQuestionCalls).toBe(3); // refused, refused, answered
    expect(spy.mock.calls.length - firstQuestionCalls).toBe(1);
  });

  it('keeps a model that accepts everything on the forced, temperature-set path', async () => {
    const { bodies } = fakeApi({}, () => toolAnswer({ answer: 'ok', confidence: 0.9 }));
    await new AnthropicModel('test-key', 'claude-haiku-4-5-20251001').completeStructured(REQUEST);

    expect(bodies).toHaveLength(1);
    expect((bodies[0]!.tool_choice as { type: string }).type).toBe('any');
    expect(bodies[0]).toHaveProperty('temperature');
  });

  it('accepts the JSON written as text when the model does not call the tool', async () => {
    fakeApi({ forcedTool: true }, () =>
      textAnswer('```json\n{"answer": "Atlas closes Friday", "confidence": 0.7}\n```'),
    );
    const result = await new AnthropicModel('test-key', 'claude-opus-5-5').completeStructured(REQUEST);
    expect(result.value.answer).toBe('Atlas closes Friday');
  });

  it('still validates that text: prose with no JSON is not an answer', async () => {
    fakeApi({ forcedTool: true }, () => textAnswer('Atlas probably closes soon, I think.'));
    await expect(
      new AnthropicModel('test-key', 'claude-opus-5-5').completeStructured(REQUEST),
    ).rejects.toThrow(/Structured output failed/);
  });

  it('does not loop when the same option is refused again', async () => {
    // A detection bug would otherwise retry forever.
    const spy = vi.fn(async () => new Response(TEMPERATURE_400, { status: 400 }));
    vi.stubGlobal('fetch', spy);

    await expect(new AnthropicModel('test-key', 'claude-opus-5-5').completeStructured(REQUEST)).rejects.toThrow(
      /temperature/,
    );
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
