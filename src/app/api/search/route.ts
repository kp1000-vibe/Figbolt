import { NextResponse } from 'next/server';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { accounts, contacts, knowledgeDocuments, meetings, opportunities, tasks } from '@/db/schema';
import { requireCtx, scope, scoped } from '@/server/context';
import { UnauthenticatedError } from '@/lib/auth/session';
import { checkRateLimit } from '@/server/rate-limit';

/**
 * Global record search for the command bar.
 *
 * Prefix/trigram matching only — fast enough to run on every keystroke.
 * Semantic search lives behind Ask AI, where the extra latency buys a real
 * answer rather than a list.
 */
export async function GET(request: Request) {
  let ctx: Awaited<ReturnType<typeof requireCtx>>;
  try {
    ctx = await requireCtx();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
    }
    throw err;
  }

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json({ hits: [] });

  const limit = await checkRateLimit(`search:${ctx.workspaceId}:${ctx.userId}`, 240, 60);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Slow down.' }, { status: 429 });
  }

  const like = `%${q}%`;

  const [accountRows, contactRows, oppRows, meetingRows, taskRows, docRows] = await Promise.all([
    ctx.db
      .select({ id: accounts.id, name: accounts.name, industry: accounts.industry })
      .from(accounts)
      .where(scoped(ctx, accounts, or(ilike(accounts.name, like), ilike(accounts.domain, like))))
      .limit(5),
    ctx.db
      .select({
        id: contacts.id,
        name: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`,
        title: contacts.title,
        accountName: accounts.name,
      })
      .from(contacts)
      .leftJoin(accounts, eq(accounts.id, contacts.accountId))
      .where(
        scoped(
          ctx,
          contacts,
          or(
            ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, like),
            ilike(contacts.email, like),
          ),
        ),
      )
      .limit(5),
    ctx.db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        value: opportunities.value,
        accountName: accounts.name,
      })
      .from(opportunities)
      .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
      .where(scoped(ctx, opportunities, or(ilike(opportunities.name, like), ilike(accounts.name, like))))
      .orderBy(desc(opportunities.value))
      .limit(5),
    ctx.db
      .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt })
      .from(meetings)
      .where(scoped(ctx, meetings, ilike(meetings.title, like)))
      .orderBy(desc(meetings.startsAt))
      .limit(4),
    ctx.db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(scoped(ctx, tasks, ilike(tasks.title, like)))
      .limit(3),
    ctx.db
      .select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title, category: knowledgeDocuments.category })
      .from(knowledgeDocuments)
      .where(scoped(ctx, knowledgeDocuments, ilike(knowledgeDocuments.title, like)))
      .limit(3),
  ]);

  const hits = [
    ...accountRows.map((r) => ({
      type: 'account' as const,
      id: r.id,
      label: r.name,
      sublabel: r.industry ?? undefined,
      href: `/accounts/${r.id}`,
    })),
    ...oppRows.map((r) => ({
      type: 'opportunity' as const,
      id: r.id,
      label: r.name,
      sublabel: `${r.accountName} · $${r.value.toLocaleString()}`,
      href: `/opportunities/${r.id}`,
    })),
    ...contactRows.map((r) => ({
      type: 'contact' as const,
      id: r.id,
      label: r.name,
      sublabel: [r.title, r.accountName].filter(Boolean).join(' · ') || undefined,
      href: `/contacts/${r.id}`,
    })),
    ...meetingRows.map((r) => ({
      type: 'meeting' as const,
      id: r.id,
      label: r.title,
      sublabel: r.startsAt.toISOString().slice(0, 10),
      href: `/meetings/${r.id}`,
    })),
    ...taskRows.map((r) => ({
      type: 'task' as const,
      id: r.id,
      label: r.title,
      sublabel: r.status,
      href: `/tasks`,
    })),
    ...docRows.map((r) => ({
      type: 'knowledge' as const,
      id: r.id,
      label: r.title,
      sublabel: r.category,
      href: `/knowledge/${r.id}`,
    })),
  ];

  return NextResponse.json(
    { hits },
    // Private: results are workspace-scoped and must never land in a shared cache.
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
