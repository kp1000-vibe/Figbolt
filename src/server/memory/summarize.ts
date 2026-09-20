import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accounts,
  commitments,
  contacts,
  objections,
  opportunities,
  type AccountMemorySummary,
  type BuyingRole,
  type ContactMemorySummary,
  type OpportunityMemorySummary,
  type RecommendedAction,
  type SourceRef,
} from '@/db/schema';
import { getLanguageModel } from '@/lib/ai';
import { s } from '@/lib/ai/providers/structured';
import { scope, scoped, type Ctx } from '../context';
import { search } from '../retrieval/search';
import { scoreAccountHealth, scoreOpportunityHealth } from '../intelligence/health';
import { currentFacts, displayValue } from './facts';
import { engagementStats } from './timeline';

/**
 * LEVEL 3 — rolling relationship summaries.
 *
 * These are recomputed from evidence rather than accumulated, so a summary can
 * never drift away from the records that back it. Recommended actions are
 * derived from concrete gaps (an overdue commitment, an absent economic buyer)
 * rather than asked for freely, which keeps them specific and checkable.
 */

const SUMMARY_SYSTEM = `
You summarise a customer relationship for a sales team.

Rules:
- Use only the evidence provided. Never introduce a fact that is not in it.
- Be concrete: name people, amounts, dates and blockers that were actually stated.
- Say "not stated" rather than guessing when something is missing.
- Keep each item to one sentence.
`.trim();

const relationshipSchema = s.object(
  {
    relationship: s.string('2-3 sentences on the state of the relationship.'),
    currentPriorities: s.strings("What the customer is focused on right now."),
    customerGoals: s.strings('Outcomes the customer said they want.'),
    recentChanges: s.strings('What has changed recently.'),
    knownRisks: s.strings('Risks to the relationship or deal.'),
    opportunities: s.strings('Expansion or upside signals.'),
    confidence: s.number('0-1 confidence.'),
  },
  ['relationship', 'currentPriorities', 'customerGoals', 'recentChanges', 'knownRisks', 'opportunities', 'confidence'],
);

export async function refreshAccountMemory(ctx: Ctx, accountId: string): Promise<AccountMemorySummary | null> {
  const [account] = await ctx.db
    .select()
    .from(accounts)
    .where(and(scope(ctx, accounts), eq(accounts.id, accountId)))
    .limit(1);
  if (!account) return null;

  const evidence = await search(ctx, {
    query: `${account.name} relationship status priorities goals risks`,
    accountId,
    scopes: ['emails', 'meetings', 'transcripts', 'notes', 'commitments', 'objections'],
    limit: 18,
    includeRecent: 6,
  });

  const [openCommitments, openObjections, health, facts, engagement] = await Promise.all([
    ctx.db
      .select()
      .from(commitments)
      .where(
        scoped(ctx, commitments, eq(commitments.accountId, accountId), inArray(commitments.status, ['open', 'overdue'])),
      )
      .limit(10),
    // Read the persisted objections rather than letting the summariser
    // re-derive them from whatever the retriever happened to return — the
    // summary has to agree with the health rationale.
    ctx.db
      .select({ category: objections.category, summary: objections.summary })
      .from(objections)
      .where(scoped(ctx, objections, eq(objections.accountId, accountId), eq(objections.status, 'open')))
      .limit(20),
    scoreAccountHealth(ctx, accountId),
    currentFacts(ctx, 'account', accountId),
    engagementStats(ctx, { accountId }, 90),
  ]);

  const model = getLanguageModel();
  const factLines = facts.map((f) => `${f.label}: ${displayValue(f)}`).join('\n');

  const result = await model.completeStructured<Record<string, unknown>>({
    system: SUMMARY_SYSTEM,
    instruction: [
      `subjectName: ${account.name}`,
      `industry: ${account.industry ?? 'not stated'}`,
      `lifecycle: ${account.lifecycleStage}`,
      `interactionsLast90Days: ${engagement.total}`,
      `engagementTrend: ${engagement.trend}`,
      `openConcernCount: ${openObjections.length}`,
      `openConcernCategories: ${[...new Set(openObjections.map((o) => o.category))].join(', ')}`,
      `openCommitmentCount: ${openCommitments.length}`,
      openObjections.length > 0
        ? `openConcerns:\n${openObjections.map((o) => `- ${o.category}|${o.summary}`).join('\n')}`
        : '',
      factLines ? `knownFacts:\n${factLines}` : '',
      '',
      `Summarise the relationship with ${account.name}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    schema: relationshipSchema,
    task: 'summarize_account',
    evidence,
  });

  const v = result.value;

  const summary: AccountMemorySummary = {
    relationship: String(v['relationship'] ?? ''),
    currentPriorities: asStrings(v['currentPriorities']),
    customerGoals: asStrings(v['customerGoals']),
    recentChanges: asStrings(v['recentChanges']),
    knownRisks: asStrings(v['knownRisks']).length ? asStrings(v['knownRisks']) : (health?.risks ?? []).map((r) => r.label),
    opportunities: asStrings(v['opportunities']),
    openCommitments: openCommitments.map(
      (c) => `${c.direction === 'we_owe' ? 'We owe' : 'They owe'}: ${c.description}`,
    ),
    recommendedActions: await deriveAccountActions(ctx, account, openCommitments, health),
    sources: evidence.slice(0, 10).map((e) => e.ref),
  };

  await ctx.db
    .update(accounts)
    .set({
      memorySummary: summary,
      memoryUpdatedAt: new Date(),
      healthScore: health?.score ?? account.healthScore,
      healthRationale: health ?? account.healthRationale,
      engagementTrend: engagement.trend,
    })
    .where(eq(accounts.id, accountId));

  return summary;
}

async function deriveAccountActions(
  ctx: Ctx,
  account: typeof accounts.$inferSelect,
  openCommitments: (typeof commitments.$inferSelect)[],
  health: Awaited<ReturnType<typeof scoreAccountHealth>>,
): Promise<RecommendedAction[]> {
  const actions: RecommendedAction[] = [];

  const overdue = openCommitments.filter(
    (c) => c.direction === 'we_owe' && c.dueAt && c.dueAt.getTime() < Date.now(),
  );
  for (const c of overdue.slice(0, 2)) {
    actions.push({
      title: `Close out: ${c.description}`,
      why: `We committed to this${c.dueAt ? ` by ${c.dueAt.toISOString().slice(0, 10)}` : ''} and it is still open.`,
      action: { kind: 'create_task', payload: { title: c.description, accountId: account.id, commitmentId: c.id } },
    });
  }

  const daysSince = account.lastInteractionAt
    ? Math.floor((Date.now() - account.lastInteractionAt.getTime()) / 86_400_000)
    : null;

  if (daysSince != null && daysSince > 14) {
    actions.push({
      title: 'Re-engage the account',
      why: `No recorded interaction for ${daysSince} days.`,
      action: { kind: 'draft_email', payload: { accountId: account.id, purpose: 're-engagement' } },
    });
  }

  for (const risk of (health?.risks ?? []).slice(0, 2)) {
    if (risk.label.includes('champion')) {
      actions.push({
        title: 'Identify a champion',
        why: 'No contact is currently marked as advocating internally, which is the strongest single predictor of a deal closing.',
      });
    } else if (risk.label.includes('economic buyer')) {
      actions.push({
        title: 'Get the economic buyer into a conversation',
        why: risk.detail ?? 'The person who signs has not engaged.',
        action: { kind: 'schedule_meeting', payload: { accountId: account.id } },
      });
    }
  }

  return actions.slice(0, 5);
}

/* ── Opportunity ──────────────────────────────────────────────────────────── */

const opportunitySchema = s.object(
  {
    summary: s.string('2-3 sentences on where the deal stands.'),
    whyBuying: s.string('Why the customer is evaluating, in their words.'),
    competitors: s.strings('Competitors mentioned.'),
    objections: s.strings('Open objections.'),
    recentChanges: s.strings('What changed recently.'),
    missingInformation: s.strings('What we still do not know.'),
    confidence: s.number('0-1 confidence.'),
  },
  ['summary', 'whyBuying', 'competitors', 'objections', 'recentChanges', 'missingInformation', 'confidence'],
);

export async function refreshOpportunityMemory(
  ctx: Ctx,
  opportunityId: string,
): Promise<OpportunityMemorySummary | null> {
  const [opp] = await ctx.db
    .select()
    .from(opportunities)
    .where(and(scope(ctx, opportunities), eq(opportunities.id, opportunityId)))
    .limit(1);
  if (!opp) return null;

  const [account] = await ctx.db
    .select({ name: accounts.name })
    .from(accounts)
    .where(and(scope(ctx, accounts), eq(accounts.id, opp.accountId)))
    .limit(1);

  const evidence = await search(ctx, {
    query: `${opp.name} ${account?.name ?? ''} deal status blockers next steps`,
    opportunityId,
    accountId: opp.accountId,
    scopes: ['emails', 'meetings', 'transcripts', 'notes', 'commitments', 'objections'],
    limit: 18,
    includeRecent: 6,
  });

  const [stakeholders, openObjections, openCommitments, health] = await Promise.all([
    ctx.db
      .select({
        id: contacts.id,
        name: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`,
        buyingRole: contacts.buyingRole,
        title: contacts.title,
      })
      .from(contacts)
      .where(scoped(ctx, contacts, eq(contacts.accountId, opp.accountId))),
    ctx.db
      .select()
      .from(objections)
      .where(scoped(ctx, objections, eq(objections.opportunityId, opportunityId), inArray(objections.status, ['open', 'addressed']))),
    ctx.db
      .select()
      .from(commitments)
      .where(scoped(ctx, commitments, eq(commitments.opportunityId, opportunityId), inArray(commitments.status, ['open', 'overdue']))),
    scoreOpportunityHealth(ctx, opportunityId),
  ]);

  const model = getLanguageModel();
  const facts = await currentFacts(ctx, 'opportunity', opportunityId);

  const result = await model.completeStructured<Record<string, unknown>>({
    system: SUMMARY_SYSTEM,
    instruction: [
      `subjectName: ${opp.name}`,
      `accountName: ${account?.name ?? 'unknown'}`,
      `value: $${opp.value.toLocaleString()}`,
      `status: ${opp.status}`,
      `openConcernCount: ${openObjections.length}`,
      `openConcernCategories: ${[...new Set(openObjections.map((o) => o.category))].join(', ')}`,
      `openCommitmentCount: ${openCommitments.length}`,
      openObjections.length > 0
        ? `openConcerns:\n${openObjections.map((o) => `- ${o.category}|${o.summary}`).join('\n')}`
        : '',
      facts.length ? `knownFacts:\n${facts.map((f) => `${f.label}: ${displayValue(f)}`).join('\n')}` : '',
      '',
      'Summarise where this deal stands.',
    ]
      .filter(Boolean)
      .join('\n'),
    schema: opportunitySchema,
    task: 'summarize_opportunity',
    evidence,
  });

  const v = result.value;

  const summary: OpportunityMemorySummary = {
    summary: String(v['summary'] ?? ''),
    whyBuying: String(v['whyBuying'] ?? 'Not stated in the recorded conversations.'),
    keyStakeholders: stakeholders
      .filter((s) => s.buyingRole && s.buyingRole !== 'unknown')
      .map((s) => ({
        contactId: s.id,
        name: s.name,
        role: (s.buyingRole ?? 'unknown') as BuyingRole,
        note: s.title ?? undefined,
      })),
    competitors: asStrings(v['competitors']),
    objections: openObjections.map((o) => `${o.category}: ${o.summary}`),
    risks: health?.risks ?? [],
    recentChanges: asStrings(v['recentChanges']),
    nextBestActions: deriveDealActions(opp, openObjections, openCommitments, health),
    // Computed from the facts table, not asked of the model. "Do we know their
    // budget?" is a question about our own data, and a keyword scan of the
    // transcript answers it wrongly the moment someone says the word "budget"
    // without stating one.
    missingInformation: computeGaps(opp, facts, stakeholders),
    sources: evidence.slice(0, 10).map((e) => e.ref),
  };

  await ctx.db
    .update(opportunities)
    .set({
      memorySummary: summary,
      memoryUpdatedAt: new Date(),
      healthScore: health?.score ?? opp.healthScore,
      healthRationale: health ?? opp.healthRationale,
    })
    .where(eq(opportunities.id, opportunityId));

  return summary;
}

function deriveDealActions(
  opp: typeof opportunities.$inferSelect,
  openObjections: (typeof objections.$inferSelect)[],
  openCommitments: (typeof commitments.$inferSelect)[],
  health: Awaited<ReturnType<typeof scoreOpportunityHealth>>,
): RecommendedAction[] {
  const actions: RecommendedAction[] = [];

  const overdue = openCommitments.filter(
    (c) => c.direction === 'we_owe' && c.dueAt && c.dueAt.getTime() < Date.now(),
  );
  for (const c of overdue.slice(0, 2)) {
    actions.push({
      title: `Deliver: ${c.description}`,
      why: `Overdue commitment${c.dueAt ? ` (due ${c.dueAt.toISOString().slice(0, 10)})` : ''}. Missed promises are the fastest way to lose a champion.`,
      action: { kind: 'create_task', payload: { title: c.description, opportunityId: opp.id } },
    });
  }

  const blocking = openObjections.filter((o) => o.severity === 'high' && o.status === 'open');
  for (const o of blocking.slice(0, 2)) {
    actions.push({
      title: `Resolve the ${o.category} objection`,
      why: o.summary,
      action: { kind: 'open_record', payload: { type: 'objection', id: o.id } },
    });
  }

  for (const risk of (health?.risks ?? []).slice(0, 3)) {
    if (risk.label.toLowerCase().includes('economic buyer')) {
      actions.push({
        title: 'Get the economic buyer on a call',
        why: risk.detail ?? 'The budget holder has not engaged, which is the most common cause of a late-stage stall.',
        action: { kind: 'schedule_meeting', payload: { opportunityId: opp.id } },
      });
    } else if (risk.label.toLowerCase().includes('stalled') || risk.label.toLowerCase().includes('quiet')) {
      actions.push({
        title: 'Send a re-engagement follow-up',
        why: risk.detail ?? 'The conversation has gone quiet.',
        action: { kind: 'draft_email', payload: { opportunityId: opp.id, purpose: 're-engagement' } },
      });
    } else if (risk.label.toLowerCase().includes('timeline')) {
      actions.push({
        title: 'Agree an implementation timeline',
        why: 'Without a date the deal has no forcing function.',
      });
    }
  }

  return dedupeActions(actions).slice(0, 5);
}

function dedupeActions(actions: RecommendedAction[]): RecommendedAction[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = a.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ── Contact ──────────────────────────────────────────────────────────────── */

export async function refreshContactMemory(ctx: Ctx, contactId: string): Promise<ContactMemorySummary | null> {
  const [contact] = await ctx.db
    .select()
    .from(contacts)
    .where(and(scope(ctx, contacts), eq(contacts.id, contactId)))
    .limit(1);
  if (!contact) return null;

  const name = `${contact.firstName} ${contact.lastName}`;
  const evidence = await search(ctx, {
    query: `${name} priorities concerns`,
    accountId: contact.accountId ?? undefined,
    scopes: ['emails', 'meetings', 'transcripts', 'notes'],
    limit: 12,
    includeRecent: 4,
  });

  const model = getLanguageModel();
  const result = await model.completeStructured<Record<string, unknown>>({
    system: SUMMARY_SYSTEM,
    instruction: [
      `subjectName: ${name}`,
      `title: ${contact.title ?? 'not stated'}`,
      '',
      `Summarise what we know about ${name} as a stakeholder.`,
    ].join('\n'),
    schema: s.object(
      {
        summary: s.string('2-3 sentences about this person.'),
        priorities: s.strings('What they care about.'),
        concerns: s.strings('Concerns they raised.'),
        communicationStyle: s.string('How they communicate, or empty.'),
        confidence: s.number('0-1 confidence.'),
      },
      ['summary', 'priorities', 'concerns', 'confidence'],
    ),
    task: 'summarize_contact',
    evidence,
  });

  const v = result.value;
  const summary: ContactMemorySummary = {
    summary: String(v['summary'] ?? ''),
    priorities: asStrings(v['priorities']),
    concerns: asStrings(v['concerns']),
    communicationStyle: (v['communicationStyle'] as string) || undefined,
    sources: evidence.slice(0, 8).map((e) => e.ref),
  };

  await ctx.db.update(contacts).set({ memorySummary: summary }).where(eq(contacts.id, contactId));
  return summary;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 8);
}

/**
 * Qualification gaps, derived from what we actually hold.
 *
 * Each line is a concrete missing artefact rather than a vague "needs more
 * discovery", so it reads as a checklist a rep can close out.
 */
function computeGaps(
  opp: typeof opportunities.$inferSelect,
  facts: { key: string }[],
  stakeholders: { buyingRole: BuyingRole | null }[],
): string[] {
  const keys = new Set(facts.map((f) => f.key));
  const roles = new Set(stakeholders.map((s) => s.buyingRole).filter(Boolean));
  const gaps: string[] = [];

  if (!keys.has('budget')) gaps.push('No confirmed budget on record.');
  if (!keys.has('timeline')) gaps.push('No agreed implementation timeline.');
  if (!keys.has('decision_process')) gaps.push('Decision and approval process is undocumented.');
  if (!keys.has('seat_count')) gaps.push('Seat count in scope has not been established.');
  if (!roles.has('economic_buyer')) gaps.push('The economic buyer has not been identified.');
  if (!roles.has('champion')) gaps.push('No champion has been identified.');
  if (!opp.expectedCloseDate) gaps.push('No expected close date is set.');

  return gaps;
}
