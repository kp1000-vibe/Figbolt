import { NextResponse } from 'next/server';
import { authenticateRequest, type ApiKeyContext } from '@/server/api/auth';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import { allTools } from '@/lib/agents/registry';
import { can } from '@/lib/security/permissions';
import { ask } from '@/server/ai/ask';
import { buildBriefing } from '@/server/ai/briefing';
import { listInsights } from '@/server/intelligence/insights';
import { listThemes } from '@/server/intelligence/signals';
import { getPipelineSummary } from '@/server/crm/opportunities';

/**
 * Model Context Protocol server.
 *
 * This is the interface that makes Nexus agent-native rather than
 * agent-decorated: any MCP client — Claude Desktop, an internal agent, another
 * product's copilot — can read the customer world model and act on it through
 * exactly the same permission-checked, risk-gated, audited tools the in-app
 * agents use.
 *
 * The security posture is the important part. An external agent is *less*
 * trusted than an internal one, not more:
 *
 *  - it authenticates with an API key whose role is clamped to its creator's
 *  - `tools/list` returns only tools its role can actually call, so it cannot
 *    discover capability it does not have
 *  - a HIGH-risk call does not execute; it creates an approval and returns that
 *    fact, so an external agent can never send email on its own
 *  - every call lands in the audit log attributed to the key
 *
 * JSON-RPC 2.0 over HTTP POST. Stateless: each request is authenticated and
 * authorised on its own, so there is no session to hijack.
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'nexus-crm', version: '0.1.0' };

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  forbidden: -32002,
} as const;

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);

  if ('failure' in auth) {
    return NextResponse.json(
      rpcError(null, auth.failure.status === 403 ? ERRORS.forbidden : ERRORS.unauthorized, auth.failure.error),
      {
        status: auth.failure.status,
        headers: {
          // Tell a client how to authenticate rather than leaving it guessing.
          'www-authenticate': 'Bearer realm="nexus-crm"',
          'cache-control': 'no-store',
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, ERRORS.parse, 'Request body is not valid JSON.'), {
      status: 400,
    });
  }

  // JSON-RPC allows batching; handle both shapes.
  const requests: JsonRpcRequest[] = Array.isArray(body)
    ? (body as JsonRpcRequest[])
    : [body as JsonRpcRequest];

  const responses = [];
  for (const rpc of requests) {
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      responses.push(rpcError(rpc?.id ?? null, ERRORS.invalidRequest, 'Malformed JSON-RPC request.'));
      continue;
    }
    const result = await handle(auth.ctx, rpc);
    // Notifications (no id) get no response, per the spec.
    if (result !== undefined) responses.push(result);
  }

  if (responses.length === 0) return new NextResponse(null, { status: 204 });

  return NextResponse.json(Array.isArray(body) ? responses : responses[0], {
    headers: { 'cache-control': 'no-store' },
  });
}

/** Advertise the endpoint so a client can discover it without docs. */
export async function GET() {
  return NextResponse.json(
    {
      protocol: 'mcp',
      protocolVersion: PROTOCOL_VERSION,
      transport: 'http-jsonrpc',
      serverInfo: SERVER_INFO,
      authentication: {
        type: 'bearer',
        header: 'Authorization',
        format: 'Bearer nxk_…',
        note: 'Create a key in Settings → Security, or with `npm run cli -- keys:create`.',
      },
      methods: [
        'initialize',
        'tools/list',
        'tools/call',
        'resources/list',
        'resources/read',
        'prompts/list',
        'prompts/get',
      ],
      safety: {
        highRiskBehaviour:
          'A HIGH-risk tool call does not execute. It creates an approval for a human and returns the approval id.',
        toolVisibility: 'tools/list is filtered to what the calling key’s role may invoke.',
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function handle(ctx: ApiKeyContext, rpc: JsonRpcRequest) {
  const id = rpc.id ?? null;
  // A request with no id is a notification: act, but return nothing.
  const isNotification = rpc.id === undefined;

  try {
    switch (rpc.method) {
      case 'initialize':
        return isNotification
          ? undefined
          : rpcResult(id, {
              protocolVersion: PROTOCOL_VERSION,
              serverInfo: SERVER_INFO,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
              instructions: [
                'Nexus CRM exposes a customer world model: accounts, contacts, deals, and the',
                'emails, meetings and transcripts they were built from.',
                '',
                'Ground every claim about a customer in a tool result. Never invent a record,',
                'number or date. When evidence is thin, say so.',
                '',
                'Tools that change data or reach a customer may return',
                '"status": "awaiting_approval" instead of executing. That means a human must',
                'approve it in Nexus — report it as pending, never as done.',
              ].join('\n'),
            });

      case 'notifications/initialized':
        return undefined;

      case 'ping':
        return isNotification ? undefined : rpcResult(id, {});

      case 'tools/list': {
        await ensureToolsLoaded();
        // Filter by what this key may actually invoke, so capability the caller
        // lacks is not even discoverable.
        const tools = allTools()
          .filter((tool) => can(ctx.role, tool.permission))
          .map((tool) => ({
            name: tool.name,
            description: describeTool(tool.description, tool.readOnly, tool.risk),
            inputSchema: tool.parameters,
            annotations: {
              readOnlyHint: tool.readOnly,
              destructiveHint: !tool.readOnly && tool.risk === 'high',
              idempotentHint: tool.readOnly,
            },
          }));

        return rpcResult(id, { tools });
      }

      case 'tools/call': {
        const name = String(rpc.params?.['name'] ?? '');
        const args = (rpc.params?.['arguments'] ?? {}) as Record<string, unknown>;
        if (!name) {
          return rpcError(id, ERRORS.invalidParams, 'tools/call requires a "name".');
        }

        await ensureToolsLoaded();

        // No allow-list: a key's role is the allow-list. `autoApprove: ['low']`
        // means anything that mutates state stops for a human, which is the
        // correct default for a caller outside the workspace.
        const outcome = await dispatchTool(ctx, name, args, {
          autoApprove: ['low'],
          rationale: `MCP call from key "${ctx.keyName}".`,
        });

        if (outcome.status === 'ok') {
          return rpcResult(id, {
            content: [
              { type: 'text', text: outcome.result.summary },
              { type: 'text', text: JSON.stringify(outcome.result.data ?? null, null, 2) },
            ],
            structuredContent: {
              status: 'ok',
              summary: outcome.result.summary,
              data: outcome.result.data ?? null,
              sources: outcome.result.sources ?? [],
            },
            isError: false,
          });
        }

        if (outcome.status === 'needs_approval') {
          return rpcResult(id, {
            content: [
              {
                type: 'text',
                text:
                  `NOT PERFORMED. "${name}" is ${outcome.riskLevel} risk and was queued for human ` +
                  `approval in Nexus (approval id ${outcome.approvalId}). Describe this as pending, ` +
                  'not complete.',
              },
            ],
            structuredContent: {
              status: 'awaiting_approval',
              approvalId: outcome.approvalId,
              riskLevel: outcome.riskLevel,
              title: outcome.title,
            },
            // Not an error — the system worked as designed.
            isError: false,
          });
        }

        return rpcResult(id, {
          content: [{ type: 'text', text: `Tool error (${outcome.code}): ${outcome.error}` }],
          structuredContent: { status: 'error', code: outcome.code, error: outcome.error },
          isError: true,
        });
      }

      case 'resources/list':
        return rpcResult(id, {
          resources: [
            {
              uri: 'nexus://briefing/today',
              name: "Today's briefing",
              description: 'Ranked priorities, meetings, commitments due and agent activity.',
              mimeType: 'application/json',
            },
            {
              uri: 'nexus://pipeline/summary',
              name: 'Pipeline summary',
              description: 'Open, weighted and at-risk pipeline, plus quarter-to-date wins.',
              mimeType: 'application/json',
            },
            {
              uri: 'nexus://insights',
              name: 'Cross-account patterns',
              description: 'Patterns computed from this workspace’s own history, with evidence.',
              mimeType: 'application/json',
            },
            {
              uri: 'nexus://product-signals',
              name: 'Product demand',
              description: 'Requested capabilities grouped by theme, with accounts and pipeline attached.',
              mimeType: 'application/json',
            },
          ],
        });

      case 'resources/read': {
        const uri = String(rpc.params?.['uri'] ?? '');
        if (!can(ctx.role, 'record:read')) {
          return rpcError(id, ERRORS.forbidden, 'This key cannot read records.');
        }

        const payload = await readResource(ctx, uri);
        if (!payload) return rpcError(id, ERRORS.invalidParams, `Unknown resource: ${uri}`);

        return rpcResult(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
        });
      }

      case 'prompts/list':
        return rpcResult(id, {
          prompts: [
            {
              name: 'account_brief',
              description: 'Everything known about one account, grounded in cited records.',
              arguments: [{ name: 'account', description: 'Account name or id.', required: true }],
            },
            {
              name: 'deal_review',
              description: 'What is blocking a deal and what to do next, with evidence.',
              arguments: [{ name: 'deal', description: 'Deal name or id.', required: true }],
            },
            {
              name: 'ask',
              description: 'Ask any question about the CRM and get a cited answer.',
              arguments: [{ name: 'question', description: 'The question.', required: true }],
            },
          ],
        });

      case 'prompts/get': {
        const name = String(rpc.params?.['name'] ?? '');
        const args = (rpc.params?.['arguments'] ?? {}) as Record<string, string>;

        if (!can(ctx.role, 'ai:ask')) {
          return rpcError(id, ERRORS.forbidden, 'This key cannot use AI surfaces.');
        }

        const question =
          name === 'account_brief'
            ? `What is happening with ${args['account'] ?? ''}? Include open commitments, concerns and what to do next.`
            : name === 'deal_review'
              ? `What is blocking the ${args['deal'] ?? ''} deal, and what should we do next?`
              : (args['question'] ?? '');

        if (!question.trim()) {
          return rpcError(id, ERRORS.invalidParams, 'That prompt needs its argument.');
        }

        const answer = await ask(ctx, { question, persist: false });

        return rpcResult(id, {
          description: `Nexus answer, grounded in ${answer.sources.length} records.`,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: question },
            },
            {
              role: 'assistant',
              content: {
                type: 'text',
                text: [
                  answer.answer,
                  '',
                  `Confidence: ${Math.round(answer.confidence * 100)}%`,
                  answer.caveat ? `Caveat: ${answer.caveat}` : '',
                  '',
                  'Sources:',
                  ...answer.sources.map((s) => `- [${s.type}] ${s.label}`),
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            },
          ],
        });
      }

      default:
        return rpcError(id, ERRORS.methodNotFound, `Unknown method: ${rpc.method}`);
    }
  } catch (err) {
    console.error(`[mcp] ${rpc.method} failed:`, err);
    return rpcError(id, ERRORS.internal, 'The server failed to handle that request.');
  }
}

async function readResource(ctx: ApiKeyContext, uri: string): Promise<unknown> {
  switch (uri) {
    case 'nexus://briefing/today':
      return buildBriefing(ctx, ctx.keyName);
    case 'nexus://pipeline/summary':
      return getPipelineSummary(ctx);
    case 'nexus://insights':
      return (await listInsights(ctx, 20)).map((i) => ({
        kind: i.kind,
        title: i.title,
        body: i.body,
        metrics: i.metrics,
        confidence: i.confidence,
        severity: i.severity,
        evidence: i.evidence,
      }));
    case 'nexus://product-signals':
      return listThemes(ctx);
    default:
      return null;
  }
}

/** Make the risk class visible in the tool description an external model reads. */
function describeTool(description: string, readOnly: boolean, risk: string): string {
  if (readOnly) return `${description} (read-only)`;
  if (risk === 'high') {
    return `${description} (HIGH RISK — will not execute; creates a human approval instead)`;
  }
  return `${description} (${risk.toUpperCase()} RISK — may require human approval)`;
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}
