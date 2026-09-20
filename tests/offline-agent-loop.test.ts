import { beforeAll, describe, expect, it } from 'vitest';
import { getLanguageModel } from '@/lib/ai';
import { ensureToolsLoaded } from '@/lib/agents/dispatch';
import { getTool } from '@/lib/agents/registry';
import type { ToolDefinition as ModelTool } from '@/lib/ai/types';

/**
 * The offline engine inside the agent loop.
 *
 * These lock down three failures that each made an agent run *look* successful
 * while reporting nothing useful — the worst kind of bug in a product whose
 * whole claim is that it tells you the truth about your customers.
 */

let searchOpportunities: ModelTool;

beforeAll(async () => {
  await ensureToolsLoaded();
  const tool = getTool('search_opportunities')!;
  searchOpportunities = { name: tool.name, description: tool.description, parameters: tool.parameters };
});

/** The task message the agent runtime actually builds. */
const TASK = [
  'Run the agent "At-Risk Deal Watch".',
  '',
  'Original request: Every weekday morning, find my three most at-risk deals — anything above $25,000 with no customer activity for 10 days or more. Research what happened on each one and tell me what I should do next.',
  '',
  'Configured filters:',
  '- minValue: 25000',
  '- inactiveDays: 10',
  '- status: "open"',
].join('\n');

describe('tool argument planning', () => {
  it('does not search for the agent\'s own name', async () => {
    // The framing line contains a quoted phrase. Treating it as a record name
    // produced a query matching nothing, and the run reported an empty CRM.
    const result = await getLanguageModel().complete({
      system: 'You are an agent.',
      messages: [{ role: 'user', content: TASK }],
      tools: [searchOpportunities],
      toolChoice: 'auto',
    });

    const call = result.toolCalls[0];
    expect(call?.name).toBe('search_opportunities');
    expect(JSON.stringify(call?.arguments)).not.toContain('At-Risk Deal Watch');
  });

  it('applies the filters a human configured on the agent', async () => {
    const result = await getLanguageModel().complete({
      system: 'You are an agent.',
      messages: [{ role: 'user', content: TASK }],
      tools: [searchOpportunities],
      toolChoice: 'auto',
    });

    const args = result.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(args['minValue']).toBe(25_000);
    expect(args['inactiveDays']).toBe(10);
    expect(args['status']).toBe('open');
  });

  it('still searches for a named record when the request names one', async () => {
    const result = await getLanguageModel().complete({
      system: 'You are an agent.',
      messages: [
        {
          role: 'user',
          content: 'Original request: What is happening with the Acme Corp deal?',
        },
      ],
      tools: [searchOpportunities],
      toolChoice: 'auto',
    });

    const args = result.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(String(args['query'] ?? '')).toContain('Acme');
  });
});

describe('final report', () => {
  it('reports what the tools returned rather than "no records matched"', async () => {
    // The tool results live in the message history, not in `evidence`. Before
    // this, the engine composed from empty evidence and told the user their
    // workspace was empty while the run had just read fifteen deals.
    const result = await getLanguageModel().complete({
      system: 'You are an agent.',
      messages: [
        { role: 'user', content: TASK },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'search_opportunities', arguments: {} }] },
        {
          role: 'tool',
          toolCallId: 't1',
          name: 'search_opportunities',
          content: `3 opportunities matched, worth $420,000 in total.\n\n${JSON.stringify([
            { id: 'opp_1', name: 'Cascade — Exception Management', account: 'Cascade Logistics', health: 32, daysSinceContact: 17 },
            { id: 'opp_2', name: 'Acme Corp — Enterprise Platform', account: 'Acme Corp', health: 37, daysSinceContact: 4 },
            { id: 'opp_3', name: 'Healthy Deal', account: 'Somewhere', health: 88, daysSinceContact: 2 },
          ])}`,
        },
      ],
      tools: [searchOpportunities],
      toolChoice: 'auto',
    });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toContain('3 opportunities matched');
    expect(result.text).toContain('Cascade — Exception Management');
    expect(result.text).toContain('health 32/100');
    expect(result.text).toContain('no contact for 17 days');
    // A healthy deal is not "worth attention".
    expect(result.text).not.toContain('Healthy Deal');
    expect(result.text).not.toMatch(/couldn'?t find any records/i);
  });

  it('says plainly that a queued action did not happen', async () => {
    const result = await getLanguageModel().complete({
      system: 'You are an agent.',
      messages: [
        { role: 'user', content: TASK },
        {
          role: 'assistant',
          content: '',
          // Both available tools have been called, so the engine has nothing
          // left to plan and must produce its report.
          toolCalls: [
            { id: 't0', name: 'search_opportunities', arguments: {} },
            { id: 't1', name: 'send_email', arguments: {} },
          ],
        },
        {
          role: 'tool',
          toolCallId: 't0',
          name: 'search_opportunities',
          content: '1 opportunity matched, worth $50,000 in total.\n\n[]',
        },
        {
          role: 'tool',
          toolCallId: 't1',
          name: 'send_email',
          content:
            'This action was NOT performed. It has been queued for human approval (id apr_123). Continue with other work, and describe it as "awaiting approval" in your summary.',
        },
      ],
      tools: [searchOpportunities],
      toolChoice: 'auto',
    });

    expect(result.text).toMatch(/awaiting human approval/i);
    expect(result.text).toMatch(/NOT been performed/i);
  });
});
