import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, keyPermissions, type ApiKeyContext } from '@/server/api/auth';
import { can } from '@/lib/security/permissions';
import { dispatchTool, ensureToolsLoaded } from '@/lib/agents/dispatch';
import { allTools } from '@/lib/agents/registry';
import { ask } from '@/server/ai/ask';
import { buildBriefing } from '@/server/ai/briefing';
import { listAccounts, getAccountDetail } from '@/server/crm/accounts';
import { listOpportunities, getOpportunityDetail, getPipelineSummary } from '@/server/crm/opportunities';
import { listContacts, getContactDetail } from '@/server/crm/contacts';
import { listMeetings, getMeetingDetail } from '@/server/crm/meetings';
import { listCommitments, listTasks } from '@/server/crm/tasks';
import { listInbox } from '@/server/inbox';
import { listInsights } from '@/server/intelligence/insights';
import { listThemes } from '@/server/intelligence/signals';
import { search } from '@/server/retrieval/search';
import { listRuns, runAgent } from '@/server/agents/runtime';
import { listAgents } from '@/server/agents/manage';
import { listPendingApprovals, decideApproval } from '@/server/approvals';
import { ingestExternalUsage, ingestSupportTicket } from '@/server/memory/external';
import { NotFoundError, ValidationError } from '@/server/context';
import { AuthorizationError } from '@/lib/security/permissions';

/**
 * Public REST API, v1.
 *
 * A catch-all route rather than a file per endpoint: the surface is a flat map
 * of `METHOD path` to handler, which keeps the auth, permission, error and
 * serialisation behaviour identical across every endpoint instead of repeated
 * nine times. Every handler receives the same `Ctx` a signed-in user would, so
 * tenant scoping and RBAC are not re-implemented here.
 *
 * Writes route through `dispatchTool`, which means an API caller hits the same
 * risk gate as an agent: a HIGH-risk write returns 202 with an approval id
 * rather than performing the action.
 */

type Handler = (
  ctx: ApiKeyContext,
  args: { params: Record<string, string>; query: URLSearchParams; body: unknown },
) => Promise<unknown>;

export async function GET(request: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(request, ctx, 'GET');
}
export async function POST(request: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(request, ctx, 'POST');
}
export async function PATCH(request: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return handle(request, ctx, 'PATCH');
}

async function handle(
  request: Request,
  // Optional catch-all: `path` is undefined at /api/v1 itself, which is the
  // self-documenting index.
  routeCtx: { params: Promise<{ path?: string[] }> },
  method: 'GET' | 'POST' | 'PATCH',
) {
  const { path } = await routeCtx.params;
  const segments = path ?? [];

  // The index is public: it documents how to authenticate.
  if (segments.length === 0 && method === 'GET') {
    return NextResponse.json(apiIndex(), { headers: { 'cache-control': 'no-store' } });
  }

  const auth = await authenticateRequest(request);
  if ('failure' in auth) {
    return NextResponse.json(
      { error: auth.failure.error },
      {
        status: auth.failure.status,
        headers: { 'www-authenticate': 'Bearer realm="nexus-crm"', 'cache-control': 'no-store' },
      },
    );
  }
  const ctx = auth.ctx;

  const matched = matchRoute(method, segments);
  if (!matched) {
    return NextResponse.json(
      { error: `No such endpoint: ${method} /api/v1/${segments.join('/')}`, see: '/api/v1' },
      { status: 404 },
    );
  }

  let body: unknown = undefined;
  if (method !== 'GET') {
    body = await request.json().catch(() => ({}));
  }

  try {
    const data = await matched.handler(ctx, {
      params: matched.params,
      query: new URL(request.url).searchParams,
      body,
    });

    // A handler may signal "queued for approval" by returning this shape.
    if (data && typeof data === 'object' && '__status' in data) {
      const { __status, ...rest } = data as { __status: number } & Record<string, unknown>;
      return NextResponse.json(rest, { status: __status, headers: { 'cache-control': 'no-store' } });
    }

    return NextResponse.json({ data }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
    }
    if (err instanceof AuthorizationError) {
      return NextResponse.json(
        { error: err.message, requiredPermission: err.permission },
        { status: 403 },
      );
    }
    console.error(`[api] ${method} /${segments.join('/')} failed:`, err);
    return NextResponse.json({ error: 'Internal error. The failure has been logged.' }, { status: 500 });
  }
}

/* ── Route table ──────────────────────────────────────────────────────────── */

const ROUTES: { method: string; pattern: string[]; handler: Handler }[] = [
  /* Read ------------------------------------------------------------------ */
  {
    method: 'GET',
    pattern: ['accounts'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      const { rows, total } = await listAccounts(ctx, {
        query: query.get('q') ?? undefined,
        industry: query.get('industry') ?? undefined,
        lifecycleStage: query.get('stage') ?? undefined,
        flag: query.get('flag') ?? undefined,
        limit: numberParam(query, 'limit', 50, 200),
        offset: numberParam(query, 'offset', 0, 10_000),
      });
      return { accounts: rows, total };
    },
  },
  {
    method: 'GET',
    pattern: ['accounts', ':id'],
    handler: async (ctx, { params }) => {
      requirePermission(ctx, 'record:read');
      const detail = await getAccountDetail(ctx, params['id']!);
      return {
        account: detail.account,
        contacts: detail.contacts,
        opportunities: detail.opportunities,
        commitments: detail.commitments,
        objections: detail.objections,
        facts: detail.facts,
        engagement: detail.engagement,
      };
    },
  },
  {
    method: 'GET',
    pattern: ['opportunities'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      const result = await listOpportunities(ctx, {
        query: query.get('q') ?? undefined,
        status: (query.get('status') as 'open' | 'won' | 'lost') ?? undefined,
        flag: (query.get('flag') as 'at_risk' | 'quiet' | 'closing_soon' | 'overdue_close') ?? undefined,
        minValue: query.get('min_value') ? Number(query.get('min_value')) : undefined,
        limit: numberParam(query, 'limit', 50, 500),
      });
      return { opportunities: result.rows, total: result.total, totalValue: result.totalValue };
    },
  },
  {
    method: 'GET',
    pattern: ['opportunities', ':id'],
    handler: async (ctx, { params }) => {
      requirePermission(ctx, 'record:read');
      const detail = await getOpportunityDetail(ctx, params['id']!);
      return {
        opportunity: detail.opportunity,
        account: detail.account,
        stage: detail.stage,
        stakeholders: detail.stakeholders,
        commitments: detail.commitments,
        objections: detail.objections,
        facts: detail.facts,
        engagement: detail.engagement,
      };
    },
  },
  {
    method: 'GET',
    pattern: ['contacts'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      const result = await listContacts(ctx, {
        query: query.get('q') ?? undefined,
        accountId: query.get('account_id') ?? undefined,
        buyingRole: query.get('buying_role') ?? undefined,
        limit: numberParam(query, 'limit', 50, 300),
      });
      return { contacts: result.rows, total: result.total };
    },
  },
  {
    method: 'GET',
    pattern: ['contacts', ':id'],
    handler: async (ctx, { params }) => {
      requirePermission(ctx, 'record:read');
      return getContactDetail(ctx, params['id']!);
    },
  },
  {
    method: 'GET',
    pattern: ['meetings'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      return {
        meetings: await listMeetings(ctx, {
          query: query.get('q') ?? undefined,
          accountId: query.get('account_id') ?? undefined,
          bucket: query.get('bucket') ?? undefined,
          limit: numberParam(query, 'limit', 50, 200),
        }),
      };
    },
  },
  {
    method: 'GET',
    pattern: ['meetings', ':id'],
    handler: async (ctx, { params }) => {
      requirePermission(ctx, 'record:read');
      return getMeetingDetail(ctx, params['id']!);
    },
  },
  {
    method: 'GET',
    pattern: ['commitments'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      return {
        commitments: await listCommitments(ctx, {
          direction: (query.get('direction') as 'we_owe' | 'they_owe') ?? undefined,
          bucket: (query.get('bucket') as 'overdue' | 'due_soon' | 'open') ?? undefined,
          accountId: query.get('account_id') ?? undefined,
          limit: numberParam(query, 'limit', 100, 200),
        }),
      };
    },
  },
  {
    method: 'GET',
    pattern: ['tasks'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      return {
        tasks: await listTasks(ctx, {
          status: (query.get('status') as 'open' | 'in_progress' | 'completed' | 'cancelled') ?? undefined,
          bucket: query.get('bucket') ?? undefined,
          limit: numberParam(query, 'limit', 100, 200),
        }),
      };
    },
  },
  {
    method: 'GET',
    pattern: ['search'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      const q = query.get('q');
      if (!q) throw new ValidationError('The "q" parameter is required.');

      const results = await search(ctx, {
        query: q,
        limit: numberParam(query, 'limit', 12, 40),
        sinceDays: numberParam(query, 'since_days', 0, 730),
      });

      return {
        results: results.map((r) => ({
          type: r.ref.type,
          id: r.ref.id,
          label: r.ref.label,
          occurredAt: r.ref.occurredAt,
          trust: r.trust,
          score: r.score,
          excerpt: r.content.slice(0, 1200),
        })),
      };
    },
  },
  {
    method: 'GET',
    pattern: ['inbox'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return { items: await listInbox(ctx, { limit: 100 }) };
    },
  },
  {
    method: 'GET',
    pattern: ['briefing'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return buildBriefing(ctx, ctx.keyName);
    },
  },
  {
    method: 'GET',
    pattern: ['insights'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return { insights: await listInsights(ctx, 20) };
    },
  },
  {
    method: 'GET',
    pattern: ['product-signals'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return { themes: await listThemes(ctx) };
    },
  },
  {
    method: 'GET',
    pattern: ['pipeline', 'summary'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return getPipelineSummary(ctx);
    },
  },
  {
    method: 'GET',
    pattern: ['agents'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return { agents: await listAgents(ctx) };
    },
  },
  {
    method: 'GET',
    pattern: ['agents', 'runs'],
    handler: async (ctx, { query }) => {
      requirePermission(ctx, 'record:read');
      return {
        runs: await listRuns(ctx, {
          agentId: query.get('agent_id') ?? undefined,
          limit: numberParam(query, 'limit', 25, 100),
        }),
      };
    },
  },
  {
    method: 'GET',
    pattern: ['approvals'],
    handler: async (ctx) => {
      requirePermission(ctx, 'record:read');
      return { approvals: await listPendingApprovals(ctx, 50) };
    },
  },
  {
    method: 'GET',
    pattern: ['tools'],
    handler: async (ctx) => {
      await ensureToolsLoaded();
      return {
        tools: allTools()
          .filter((tool) => can(ctx.role, tool.permission))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            risk: tool.risk,
            readOnly: tool.readOnly,
            permission: tool.permission,
            inputSchema: tool.parameters,
          })),
        yourRole: ctx.role,
        yourPermissions: keyPermissions(ctx),
      };
    },
  },

  /* Write ----------------------------------------------------------------- */
  {
    method: 'POST',
    pattern: ['ask'],
    handler: async (ctx, { body }) => {
      requirePermission(ctx, 'ai:ask');
      const parsed = z
        .object({
          question: z.string().trim().min(2).max(2000),
          scopeType: z.enum(['account', 'opportunity', 'contact']).optional(),
          scopeId: z.string().optional(),
        })
        .safeParse(body);
      if (!parsed.success) throw new ValidationError('A "question" is required.');

      const answer = await ask(ctx, { ...parsed.data, persist: false });
      return {
        answer: answer.answer,
        confidence: answer.confidence,
        caveat: answer.caveat ?? null,
        sources: answer.sources,
        recommendedActions: answer.recommendedActions,
        reasoningSummary: answer.reasoningSummary,
        analytics: answer.analytics ?? null,
      };
    },
  },
  {
    method: 'POST',
    pattern: ['tools', ':name'],
    handler: async (ctx, { params, body }) => {
      await ensureToolsLoaded();

      // External callers get the conservative policy: only read-only tools run
      // unattended, everything else becomes an approval.
      const outcome = await dispatchTool(ctx, params['name']!, body ?? {}, {
        autoApprove: ['low'],
        rationale: `REST API call from key "${ctx.keyName}".`,
      });

      if (outcome.status === 'ok') {
        return {
          status: 'ok',
          summary: outcome.result.summary,
          data: outcome.result.data,
          sources: outcome.result.sources ?? [],
        };
      }
      if (outcome.status === 'needs_approval') {
        return {
          // 202: accepted, not performed.
          __status: 202,
          status: 'awaiting_approval',
          approvalId: outcome.approvalId,
          riskLevel: outcome.riskLevel,
          title: outcome.title,
          message:
            'This action was not performed. It requires human approval in Nexus. Report it as pending.',
        };
      }
      return { __status: outcome.code === 'FORBIDDEN' ? 403 : 400, status: 'error', error: outcome.error, code: outcome.code };
    },
  },
  {
    method: 'POST',
    pattern: ['agents', ':id', 'run'],
    handler: async (ctx, { params }) => {
      requirePermission(ctx, 'ai:run_agent');
      const outcome = await runAgent(ctx, params['id']!, {
        kind: 'webhook',
        detail: `REST API call from key "${ctx.keyName}"`,
      });
      return {
        runId: outcome.runId,
        status: outcome.status,
        summary: outcome.summary,
        pendingApprovals: outcome.pendingApprovals,
        steps: outcome.steps,
        latencyMs: outcome.latencyMs,
      };
    },
  },
  {
    method: 'POST',
    pattern: ['approvals', ':id', 'decide'],
    handler: async (ctx, { params, body }) => {
      const parsed = z
        .object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() })
        .safeParse(body);
      if (!parsed.success) throw new ValidationError('A "decision" of approve or reject is required.');

      const result = await decideApproval(ctx, {
        approvalId: params['id']!,
        decision: parsed.data.decision,
        note: parsed.data.note,
      });

      return {
        status: result.approval.status,
        executed: result.executed,
        error: result.error ?? null,
      };
    },
  },

  /* Ingestion ------------------------------------------------------------- */
  {
    method: 'POST',
    pattern: ['ingest', 'usage'],
    handler: async (ctx, { body }) => {
      requirePermission(ctx, 'record:create');
      const parsed = z
        .object({
          accountDomain: z.string().optional(),
          accountId: z.string().optional(),
          day: z.string(),
          activeUsers: z.number().int().min(0).default(0),
          sessions: z.number().int().min(0).default(0),
          events: z.number().int().min(0).default(0),
          keyActions: z.number().int().min(0).default(0),
          contactEmail: z.string().optional(),
          source: z.string().max(40).default('api'),
        })
        .safeParse(body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid usage payload.');
      }
      return ingestExternalUsage(ctx, parsed.data);
    },
  },
  {
    method: 'POST',
    pattern: ['ingest', 'ticket'],
    handler: async (ctx, { body }) => {
      requirePermission(ctx, 'record:create');
      const parsed = z
        .object({
          externalId: z.string().optional(),
          provider: z.string().max(40).default('api'),
          subject: z.string().min(2).max(400),
          body: z.string().max(50_000).default(''),
          status: z.enum(['open', 'pending', 'resolved', 'closed']).default('open'),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
          contactEmail: z.string().optional(),
          accountDomain: z.string().optional(),
          openedAt: z.string().optional(),
          satisfaction: z.number().min(0).max(5).optional(),
        })
        .safeParse(body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid ticket payload.');
      }
      return ingestSupportTicket(ctx, parsed.data);
    },
  },
];

function matchRoute(
  method: string,
  segments: string[],
): { handler: Handler; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.pattern.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let ok = true;

    for (const [i, part] of route.pattern.entries()) {
      const actual = segments[i]!;
      if (part.startsWith(':')) params[part.slice(1)] = actual;
      else if (part !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: route.handler, params };
  }
  return null;
}

function requirePermission(ctx: ApiKeyContext, permission: Parameters<typeof can>[1]): void {
  if (!can(ctx.role, permission)) {
    throw new AuthorizationError(permission, ctx.role);
  }
}

function numberParam(query: URLSearchParams, key: string, fallback: number, max: number): number {
  const raw = query.get(key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

function apiIndex() {
  return {
    name: 'Nexus CRM API',
    version: 'v1',
    authentication: {
      type: 'bearer',
      header: 'Authorization: Bearer nxk_…',
      alternative: 'X-Api-Key: nxk_…',
      note: 'Create a key in Settings → Security, or with `npm run cli -- keys:create`.',
      rateLimit: '600 requests per minute per key',
    },
    safety: {
      writes:
        'Writes route through the same risk gate as agents. A HIGH-risk write returns 202 with an approval id and is NOT performed.',
      scoping: 'Every response is scoped to the key’s workspace. A key cannot read another tenant.',
      roles: 'A key’s role is capped by the current role of the user who created it.',
    },
    endpoints: {
      read: [
        'GET /api/v1/accounts?q=&industry=&stage=&flag=at_risk&limit=',
        'GET /api/v1/accounts/:id',
        'GET /api/v1/opportunities?status=open&flag=at_risk&min_value=',
        'GET /api/v1/opportunities/:id',
        'GET /api/v1/contacts?q=&account_id=&buying_role=',
        'GET /api/v1/contacts/:id',
        'GET /api/v1/meetings?bucket=past',
        'GET /api/v1/meetings/:id',
        'GET /api/v1/commitments?direction=we_owe&bucket=overdue',
        'GET /api/v1/tasks?bucket=overdue',
        'GET /api/v1/search?q=customers+worried+about+deployment',
        'GET /api/v1/inbox',
        'GET /api/v1/briefing',
        'GET /api/v1/insights',
        'GET /api/v1/product-signals',
        'GET /api/v1/pipeline/summary',
        'GET /api/v1/agents',
        'GET /api/v1/agents/runs?agent_id=',
        'GET /api/v1/approvals',
        'GET /api/v1/tools',
      ],
      write: [
        'POST /api/v1/ask                      { question, scopeType?, scopeId? }',
        'POST /api/v1/tools/:name              <tool input schema>',
        'POST /api/v1/agents/:id/run',
        'POST /api/v1/approvals/:id/decide     { decision: "approve" | "reject", note? }',
      ],
      ingest: [
        'POST /api/v1/ingest/usage             { accountDomain|accountId, day, activeUsers, sessions, events, keyActions }',
        'POST /api/v1/ingest/ticket            { subject, body, contactEmail|accountDomain, status, priority }',
      ],
    },
    mcp: {
      endpoint: '/api/mcp',
      note: 'JSON-RPC 2.0 Model Context Protocol server exposing the same tools to MCP clients.',
    },
  };
}
