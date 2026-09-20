import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCtx } from '@/server/context';
import { UnauthenticatedError } from '@/lib/auth/session';
import { ingestMeeting } from '@/server/memory/ingest';
import { refreshAccountMemory, refreshOpportunityMemory } from '@/server/memory/summarize';
import { ctxAssert } from '@/server/context';
import { checkRateLimit } from '@/server/rate-limit';
import { getMeetingDetail } from '@/server/crm/meetings';

/**
 * Re-run extraction over a stored transcript.
 *
 * Safe by construction: the raw transcript is never mutated, so re-deriving is
 * idempotent and is the intended recovery path after an extraction fix.
 */
export async function POST(request: Request) {
  let ctx: Awaited<ReturnType<typeof requireCtx>>;
  try {
    ctx = await requireCtx();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
    }
    throw err;
  }

  ctxAssert(ctx, 'record:update');

  const limit = await checkRateLimit(`reprocess:${ctx.workspaceId}`, 30, 300);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many reprocess requests.' }, { status: 429 });
  }

  const parsed = z
    .object({ meetingId: z.string().min(1) })
    .safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  const intelligence = await ingestMeeting(ctx, parsed.data.meetingId);
  if (!intelligence) {
    return NextResponse.json({ error: 'Meeting not found in this workspace.' }, { status: 404 });
  }

  // Downstream summaries and health depend on what was just extracted.
  const detail = await getMeetingDetail(ctx, parsed.data.meetingId);
  if (detail.account) await refreshAccountMemory(ctx, detail.account.id);
  if (detail.opportunity) await refreshOpportunityMemory(ctx, detail.opportunity.id);

  return NextResponse.json({ ok: true, confidence: intelligence.confidence });
}
