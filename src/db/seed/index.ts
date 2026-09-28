import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import {
  accounts,
  agents,
  automations,
  commitments,
  contacts,
  emailThreads,
  emails,
  knowledgeChunks,
  knowledgeDocuments,
  meetingParticipants,
  meetings,
  notes,
  opportunities,
  pipelineStages,
  pipelines,
  relationships,
  tasks,
  transcripts,
  users,
  workspaceMembers,
  workspaces,
  type RelationshipType,
  type TranscriptSegment,
} from '@/db/schema';
import { hashPassword } from '@/lib/security/crypto';
import { chunkText, toVectorLiteral } from '@/lib/ai/embeddings';
import { getEmbeddingModel } from '@/lib/ai';
import type { Ctx } from '@/server/context';
import { ingestEmail, ingestMeeting, indexForSearch } from '@/server/memory/ingest';
import { refreshAccountMemory, refreshContactMemory, refreshOpportunityMemory } from '@/server/memory/summarize';
import { addTimelineEvent } from '@/server/memory/timeline';
import { computeInsights } from '@/server/intelligence/insights';
import { seedProductAndSupportSignals } from './signals';
import { rebuildInbox } from '@/server/inbox';
import {
  ACCOUNTS,
  COMPANY_CONTEXT,
  DEMO_PASSWORD,
  KNOWLEDGE_DOCS,
  PIPELINE_STAGES,
  SECONDARY_CONTACTS,
  ADDITIONAL_DEALS,
  USERS,
} from './fixtures';
import { buildEmails, buildMeetings, buildNotes, daysAgo, makeRandom } from './narrative';

/**
 * Demo workspace seeding.
 *
 * The important design choice: this does **not** write pre-baked AI output.
 * It writes only raw sources — accounts, contacts, deals, emails, meetings,
 * transcripts, notes — and then runs the *real* memory engine over them.
 *
 * Every summary, commitment, objection, product signal, temporal fact, health
 * score and insight you see in the demo was produced by the same code path that
 * runs in production. If extraction regresses, the seeded workspace degrades
 * too, which is exactly the feedback we want.
 */

const WORKSPACE_SLUG = 'northwind-labs';

async function main() {
  const started = Date.now();
  console.log('▸ Seeding Figbolt demo workspace…\n');

  const { getHandle } = await import('@/db/client');
  const handle = await getHandle();
  const db = handle.db;

  /* ── Clean slate ─────────────────────────────────────────────────────────
   * Deleting the workspace cascades through every workspace-scoped table, so
   * re-seeding is idempotent without a per-table teardown list. */
  const [existing] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, WORKSPACE_SLUG))
    .limit(1);

  if (existing) {
    console.log('  cleaning previous demo workspace…');
    await db.delete(workspaces).where(eq(workspaces.id, existing.id));
  }
  await db.delete(users).where(sql`email LIKE '%@northwindlabs.com'`);

  /* ── Workspace ───────────────────────────────────────────────────────────── */
  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: 'Northwind Labs',
      slug: WORKSPACE_SLUG,
      domain: 'northwindlabs.com',
      companyContext: COMPANY_CONTEXT,
      onboardingStep: 'complete',
      onboardingCompletedAt: daysAgo(240),
      isDemo: true,
      aiSettings: {
        // Agents may read and analyse freely; anything that writes or leaves
        // the workspace stops for a human. This is the shipped default.
        autoApprove: { low: true, medium: false, high: false },
        autonomousEmailAgentIds: [],
        maxStepsPerRun: 12,
        redactPiiInPrompts: false,
      },
    })
    .returning();

  const workspaceId = workspace!.id;

  /* ── Users ───────────────────────────────────────────────────────────────── */
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const userIds = new Map<string, string>();

  for (const seed of USERS) {
    const [user] = await db
      .insert(users)
      .values({
        email: seed.email,
        name: seed.name,
        title: seed.title,
        passwordHash,
        lastLoginAt: daysAgo(1),
      })
      .returning({ id: users.id });

    userIds.set(seed.key, user!.id);
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId: user!.id,
      role: seed.role,
      status: 'active',
    });
  }

  const ownerUserId = userIds.get('alex')!;
  console.log(`  ✓ workspace + ${USERS.length} team members`);

  /**
   * Seeding runs as an admin system actor. Agent-authored rows are attributed
   * correctly later; the pipeline itself is infrastructure, not a user action.
   */
  const ctx: Ctx = {
    db,
    workspaceId,
    userId: ownerUserId,
    role: 'admin',
    actor: { type: 'system', id: null, label: 'Seed' },
  };

  /* ── Pipeline ────────────────────────────────────────────────────────────── */
  const [pipeline] = await db
    .insert(pipelines)
    .values({
      workspaceId,
      name: 'Enterprise Sales',
      description: 'Primary pipeline for new business.',
      isDefault: true,
    })
    .returning();

  const stageIds = new Map<string, { id: string; probability: number; type: 'open' | 'won' | 'lost' }>();
  for (const [index, stage] of PIPELINE_STAGES.entries()) {
    const [row] = await db
      .insert(pipelineStages)
      .values({
        workspaceId,
        pipelineId: pipeline!.id,
        name: stage.name,
        position: index,
        probability: stage.probability,
        type: stage.type,
        entryCriteria: stage.entryCriteria,
        color: stage.color,
      })
      .returning({ id: pipelineStages.id });
    stageIds.set(stage.name, { id: row!.id, probability: stage.probability, type: stage.type });
  }
  console.log(`  ✓ pipeline with ${PIPELINE_STAGES.length} stages`);

  /* ── Knowledge base ──────────────────────────────────────────────────────── */
  const embedder = getEmbeddingModel();
  for (const doc of KNOWLEDGE_DOCS) {
    const [row] = await db
      .insert(knowledgeDocuments)
      .values({
        workspaceId,
        title: doc.title,
        category: doc.category,
        content: doc.content,
        summary: doc.content.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 240) ?? null,
        tags: doc.tags,
        trusted: true,
        uploadedById: userIds.get('sam')!,
        indexedAt: new Date(),
      })
      .returning({ id: knowledgeDocuments.id });

    const chunks = chunkText(doc.content, { maxChars: 1200 });
    const vectors = await embedder.embed(chunks.map((c) => c.content));
    for (const [i, chunk] of chunks.entries()) {
      const vector = vectors[i];
      await db.insert(knowledgeChunks).values({
        workspaceId,
        documentId: row!.id,
        chunkIndex: chunk.index,
        heading: extractHeading(chunk.content),
        content: chunk.content,
        embedding: vector ? (sql`${toVectorLiteral(vector)}::vector` as never) : null,
        tokenCount: Math.ceil(chunk.content.length / 3.6),
      });
    }
    await indexForSearch(ctx, {
      ownerType: 'knowledge',
      ownerId: row!.id,
      label: doc.title,
      text: doc.content,
    });
  }
  console.log(`  ✓ ${KNOWLEDGE_DOCS.length} knowledge documents indexed`);

  /* ── Accounts, contacts, deals, conversations ────────────────────────────── */
  let emailCount = 0;
  let meetingCount = 0;
  let noteCount = 0;
  let taskCount = 0;
  const accountIds: { id: string; name: string }[] = [];
  const opportunityIds: string[] = [];

  for (const [accountIndex, seed] of ACCOUNTS.entries()) {
    // Per-account seeded RNG so adding an account doesn't reshuffle the others.
    const rand = makeRandom(0x9e37 + accountIndex * 7919);
    const ownerId = userIds.get(seed.ownerKey)!;
    const ownerSeed = USERS.find((u) => u.key === seed.ownerKey)!;
    const seSeed = USERS.find((u) => u.key === 'priya')!;

    const [account] = await db
      .insert(accounts)
      .values({
        workspaceId,
        name: seed.name,
        domain: seed.domain,
        website: `https://${seed.domain}`,
        industry: seed.industry,
        employeeCount: seed.employeeCount,
        currentArr: seed.currentArr ?? null,
        location: seed.location,
        country: seed.country,
        description: seed.description,
        tier: seed.tier,
        lifecycleStage: seed.lifecycleStage,
        ownerId,
        tags: [seed.tier, seed.industry.toLowerCase().replace(/\s+/g, '-')],
        createdAt: daysAgo((seed.deal?.createdDaysAgo ?? 30) + 14),
      })
      .returning({ id: accounts.id });

    const accountId = account!.id;
    accountIds.push({ id: accountId, name: seed.name });

    /* Contacts — the named buying committee, plus a couple of quieter people. */
    const contactIds: string[] = [];
    const roster = [
      ...seed.contacts,
      ...(seed.employeeCount > 500 ? (SECONDARY_CONTACTS[accountIndex % SECONDARY_CONTACTS.length] ?? []) : []),
    ];
    for (const person of roster) {
      const [contact] = await db
        .insert(contacts)
        .values({
          workspaceId,
          accountId,
          firstName: person.firstName,
          lastName: person.lastName,
          email: `${person.firstName.toLowerCase()}.${person.lastName.toLowerCase()}@${seed.domain}`,
          title: person.title,
          seniority: person.seniority,
          department: person.department,
          buyingRole: person.buyingRole,
          ownerId,
          isPrimary: person.isPrimary ?? false,
          influence: influenceFor(person.seniority, person.buyingRole),
          createdAt: daysAgo((seed.deal?.createdDaysAgo ?? 30) + 10),
        })
        .returning({ id: contacts.id });

      contactIds.push(contact!.id);

      await db
        .insert(relationships)
        .values({
          workspaceId,
          fromType: 'contact',
          fromId: contact!.id,
          type: 'works_at',
          toType: 'account',
          toId: accountId,
          confidence: 1,
          source: 'manual',
        })
        .onConflictDoNothing();
    }

    // A reporting line makes the relationship graph meaningful rather than a star.
    if (contactIds.length > 2) {
      const senior = roster.findIndex((c) => c.seniority === 'c_level' || c.seniority === 'vp');
      const junior = roster.findIndex((c) => c.seniority === 'manager' || c.seniority === 'ic');
      if (senior >= 0 && junior >= 0 && senior !== junior) {
        await db
          .insert(relationships)
          .values({
            workspaceId,
            fromType: 'contact',
            fromId: contactIds[junior]!,
            type: 'reports_to',
            toType: 'contact',
            toId: contactIds[senior]!,
            confidence: 0.8,
            source: 'derived',
          })
          .onConflictDoNothing();
      }
    }

    /* Opportunity */
    let opportunityId: string | null = null;
    if (seed.deal) {
      const stage = stageIds.get(seed.deal.stage)!;
      const isClosed = seed.deal.status !== 'open';

      const [opp] = await db
        .insert(opportunities)
        .values({
          workspaceId,
          accountId,
          pipelineId: pipeline!.id,
          stageId: stage.id,
          name: seed.deal.name,
          value: seed.deal.value,
          probability: stage.probability,
          status: seed.deal.status,
          lossReason: seed.deal.lossReason ?? null,
          expectedCloseDate: new Date(Date.now() + seed.deal.closeInDays * 86_400_000),
          closedAt: isClosed ? new Date(Date.now() + seed.deal.closeInDays * 86_400_000) : null,
          ownerId,
          source: pick(rand, ['Inbound', 'Outbound', 'Referral', 'Partner', 'Event']),
          stageEnteredAt: daysAgo(Math.max(1, Math.round(seed.deal.createdDaysAgo * 0.35))),
          position: accountIndex,
          createdAt: daysAgo(seed.deal.createdDaysAgo),
        })
        .returning({ id: opportunities.id });

      opportunityId = opp!.id;
      opportunityIds.push(opportunityId);

      await db
        .insert(relationships)
        .values({
          workspaceId,
          fromType: 'opportunity',
          fromId: opportunityId,
          type: 'belongs_to',
          toType: 'account',
          toId: accountId,
          confidence: 1,
          source: 'manual',
        })
        .onConflictDoNothing();

      // Buying-committee edges the relationship graph renders.
      for (const [i, person] of seed.contacts.entries()) {
        const edge = EDGE_FOR_ROLE[person.buyingRole];
        if (!edge) continue;
        await db
          .insert(relationships)
          .values({
            workspaceId,
            fromType: 'contact',
            fromId: contactIds[i]!,
            type: edge,
            toType: 'opportunity',
            toId: opportunityId,
            confidence: 0.9,
            source: 'derived',
          })
          .onConflictDoNothing();
      }

      await addTimelineEvent(ctx, {
        type: 'record_created',
        subjectType: 'opportunity',
        subjectId: opportunityId,
        accountId,
        opportunityId,
        title: `Opportunity created — $${seed.deal.value.toLocaleString()}`,
        occurredAt: daysAgo(seed.deal.createdDaysAgo),
        importance: 2,
      });

      if (isClosed) {
        await addTimelineEvent(ctx, {
          type: 'stage_changed',
          subjectType: 'opportunity',
          subjectId: opportunityId,
          accountId,
          opportunityId,
          title: seed.deal.status === 'won' ? 'Closed Won' : 'Closed Lost',
          body: seed.deal.lossReason ?? null,
          occurredAt: new Date(Date.now() + seed.deal.closeInDays * 86_400_000),
          importance: 5,
        });
      }
    }

    /* Emails */
    const threadIds = new Map<string, string>();
    for (const email of buildEmails(seed, ownerSeed, seSeed, rand)) {
      let threadId = threadIds.get(email.threadKey);
      if (!threadId) {
        const [thread] = await db
          .insert(emailThreads)
          .values({
            workspaceId,
            subject: email.subject.replace(/^Re:\s*/i, ''),
            accountId,
            opportunityId,
            participantEmails: [ownerSeed.email, ...seed.contacts.map(contactEmail(seed.domain))],
            provider: 'demo',
            externalId: `demo-${email.threadKey}`,
          })
          .returning({ id: emailThreads.id });
        threadId = thread!.id;
        threadIds.set(email.threadKey, threadId);
      }

      const contact = email.fromContactIndex != null ? seed.contacts[email.fromContactIndex] : undefined;
      const sentAt = daysAgo(email.daysAgo);

      const [row] = await db
        .insert(emails)
        .values({
          workspaceId,
          threadId,
          provider: 'demo',
          messageId: `<demo-${accountIndex}-${emailCount}@${seed.domain}>`,
          direction: email.direction,
          fromEmail: email.direction === 'inbound' ? contactEmail(seed.domain)(contact ?? seed.contacts[0]!) : ownerSeed.email,
          fromName: email.direction === 'inbound' ? `${(contact ?? seed.contacts[0]!).firstName} ${(contact ?? seed.contacts[0]!).lastName}` : ownerSeed.name,
          toEmails:
            email.direction === 'inbound'
              ? [ownerSeed.email]
              : [contactEmail(seed.domain)(contact ?? seed.contacts[0]!)],
          subject: email.subject,
          bodyText: email.body,
          bodySnippet: email.body.replace(/\n+/g, ' ').slice(0, 200),
          sentAt,
          accountId,
          contactId: contact ? contactIds[seed.contacts.indexOf(contact)]! : contactIds[0] ?? null,
          opportunityId,
          userId: email.direction === 'outbound' ? ownerId : null,
          createdAt: sentAt,
        })
        .returning({ id: emails.id });

      await db
        .update(emailThreads)
        .set({
          messageCount: sql`${emailThreads.messageCount} + 1`,
          lastMessageAt: sql`GREATEST(COALESCE(${emailThreads.lastMessageAt}, to_timestamp(0)), ${sentAt})`,
        })
        .where(eq(emailThreads.id, threadId));

      // The real ingestion pipeline: resolution, embedding, extraction, timeline.
      await ingestEmail(ctx, { emailId: row!.id });
      emailCount++;
    }

    /* Meetings + transcripts */
    for (const meeting of buildMeetings(seed, ownerSeed, seSeed, rand)) {
      const startsAt = daysAgo(meeting.daysAgo);
      const participantContacts = meeting.contactIndexes
        .map((i) => seed.contacts[i])
        .filter((c): c is NonNullable<typeof c> => Boolean(c));

      const [row] = await db
        .insert(meetings)
        .values({
          workspaceId,
          provider: 'demo',
          externalId: `demo-mtg-${accountIndex}-${meetingCount}`,
          title: meeting.title,
          description: `${meeting.durationMinutes}-minute call with ${participantContacts.map((c) => c.firstName).join(', ')}.`,
          startsAt,
          endsAt: new Date(startsAt.getTime() + meeting.durationMinutes * 60_000),
          meetingUrl: `https://meet.example.com/${seed.domain.split('.')[0]}-${meetingCount}`,
          status: 'completed',
          accountId,
          opportunityId,
          organizerId: ownerId,
          participantEmails: [
            ownerSeed.email,
            ...participantContacts.map(contactEmail(seed.domain)),
          ],
          createdAt: startsAt,
        })
        .returning({ id: meetings.id });

      const meetingId = row!.id;

      await db.insert(meetingParticipants).values({
        workspaceId,
        meetingId,
        userId: ownerId,
        email: ownerSeed.email,
        name: ownerSeed.name,
        isOrganizer: true,
        attended: true,
        talkRatio: 0.4,
      });

      for (const person of participantContacts) {
        await db.insert(meetingParticipants).values({
          workspaceId,
          meetingId,
          contactId: contactIds[seed.contacts.indexOf(person)] ?? null,
          email: contactEmail(seed.domain)(person),
          name: `${person.firstName} ${person.lastName}`,
          attended: true,
          talkRatio: Number((0.6 / participantContacts.length).toFixed(2)),
        });
      }

      const segments: TranscriptSegment[] = meeting.lines.map((line, index) => ({
        index,
        speaker: line.speaker,
        isCustomer: line.isCustomer,
        startSeconds: index * 24,
        text: line.text,
      }));

      await db.insert(transcripts).values({
        workspaceId,
        meetingId,
        source: 'demo',
        segments,
        fullText: segments.map((s) => `${s.speaker}: ${s.text}`).join('\n\n'),
        durationSeconds: meeting.durationMinutes * 60,
        createdAt: startsAt,
      });

      // The real meeting-intelligence pipeline.
      await ingestMeeting(ctx, meetingId);
      meetingCount++;
    }

    /* Notes */
    for (const note of buildNotes(seed, rand)) {
      const [row] = await db
        .insert(notes)
        .values({
          workspaceId,
          authorId: ownerId,
          body: note.body,
          subjectType: opportunityId ? 'opportunity' : 'account',
          subjectId: opportunityId ?? accountId,
          accountId,
          opportunityId,
          createdAt: daysAgo(note.daysAgo),
        })
        .returning({ id: notes.id });

      await indexForSearch(ctx, {
        ownerType: 'note',
        ownerId: row!.id,
        label: `Note on ${seed.name}`,
        text: note.body,
        accountId,
        opportunityId,
        occurredAt: daysAgo(note.daysAgo),
      });
      noteCount++;
    }

    /* A few open tasks so the Tasks page and briefing have real content. */
    if (seed.deal?.status === 'open' && rand() > 0.35) {
      const templates = TASK_TEMPLATES[seed.scenario] ?? TASK_TEMPLATES['default'] ?? [];
      for (const template of templates) {
        await db.insert(tasks).values({
          workspaceId,
          title: template.title.replace('{account}', seed.name).replace('{contact}', seed.contacts[0]!.firstName),
          description: template.description ?? null,
          status: 'open',
          priority: template.priority,
          dueAt: new Date(Date.now() + template.dueInDays * 86_400_000),
          assigneeId: ownerId,
          createdById: ownerId,
          accountId,
          opportunityId,
          createdAt: daysAgo(Math.min(6, seed.deal.createdDaysAgo)),
        });
        taskCount++;
      }
    }

    process.stdout.write(`\r  ✓ ${accountIndex + 1}/${ACCOUNTS.length} accounts processed`);
  }

  console.log(
    `\n  ✓ ${ACCOUNTS.length} accounts · ${emailCount} emails · ${meetingCount} meetings · ${noteCount} notes · ${taskCount} tasks`,
  );

  /* ── Additional deals ────────────────────────────────────────────────────────
   * Renewals, second-team expansions and earlier attempts. These give the
   * pipeline board depth and give win-rate analytics closed deals on accounts
   * that also have open ones — the shape a real book of business has. */
  for (const extra of ADDITIONAL_DEALS) {
    const account = accountIds.find((a) => a.name === extra.accountName);
    if (!account) continue;
    const seed = ACCOUNTS.find((a) => a.name === extra.accountName)!;
    const stage = stageIds.get(extra.stage)!;
    const isClosed = extra.status !== 'open';

    const [opp] = await db
      .insert(opportunities)
      .values({
        workspaceId,
        accountId: account.id,
        pipelineId: pipeline!.id,
        stageId: stage.id,
        name: extra.name,
        value: extra.value,
        probability: stage.probability,
        status: extra.status,
        lossReason: extra.lossReason ?? null,
        expectedCloseDate: new Date(Date.now() + extra.closeInDays * 86_400_000),
        closedAt: isClosed ? new Date(Date.now() + extra.closeInDays * 86_400_000) : null,
        ownerId: userIds.get(seed.ownerKey)!,
        source: 'Existing customer',
        stageEnteredAt: daysAgo(Math.max(1, Math.round(extra.createdDaysAgo * 0.4))),
        // Inherit the account's last interaction so renewals don't all read as stalled.
        lastInteractionAt: isClosed ? null : daysAgo(3 + (extra.createdDaysAgo % 9)),
        createdAt: daysAgo(extra.createdDaysAgo),
      })
      .returning({ id: opportunities.id });

    opportunityIds.push(opp!.id);

    await db
      .insert(relationships)
      .values({
        workspaceId,
        fromType: 'opportunity',
        fromId: opp!.id,
        type: 'belongs_to',
        toType: 'account',
        toId: account.id,
        confidence: 1,
        source: 'manual',
      })
      .onConflictDoNothing();

    await addTimelineEvent(ctx, {
      type: 'record_created',
      subjectType: 'opportunity',
      subjectId: opp!.id,
      accountId: account.id,
      opportunityId: opp!.id,
      title: `Opportunity created — $${extra.value.toLocaleString()}`,
      occurredAt: daysAgo(extra.createdDaysAgo),
      importance: 2,
    });

    if (isClosed) {
      await addTimelineEvent(ctx, {
        type: 'stage_changed',
        subjectType: 'opportunity',
        subjectId: opp!.id,
        accountId: account.id,
        opportunityId: opp!.id,
        title: extra.status === 'won' ? 'Closed Won' : 'Closed Lost',
        body: extra.lossReason ?? null,
        occurredAt: new Date(Date.now() + extra.closeInDays * 86_400_000),
        importance: 5,
      });
    }
  }
  console.log(`  ✓ ${ADDITIONAL_DEALS.length} additional deals (renewals, expansions, prior attempts)`);

  /* ── Commitment lifecycle ────────────────────────────────────────────────────
   * Extraction produces every promise ever made, all of them `open`. Left that
   * way the demo reads as a company that has never delivered anything, and deal
   * health is uniformly punished. Older promises are marked fulfilled — recent
   * ones stay open, which is where the interesting signal is. */
  const fulfilled = await db
    .update(commitments)
    .set({
      status: 'fulfilled',
      fulfilledAt: sql`${commitments.dueAt} + interval '2 days'`,
    })
    .where(
      sql`${commitments.workspaceId} = ${workspaceId}
          AND ${commitments.status} = 'open'
          AND ${commitments.dueAt} IS NOT NULL
          AND ${commitments.dueAt} < now() - interval '21 days'`,
    )
    .returning({ id: commitments.id });

  // Anything still open and past due is genuinely overdue.
  const overdue = await db
    .update(commitments)
    .set({ status: 'overdue' })
    .where(
      sql`${commitments.workspaceId} = ${workspaceId}
          AND ${commitments.status} = 'open'
          AND ${commitments.dueAt} IS NOT NULL
          AND ${commitments.dueAt} < now()`,
    )
    .returning({ id: commitments.id });

  console.log(`  ✓ commitments: ${fulfilled.length} fulfilled, ${overdue.length} overdue, rest open`);

  /* ── Product usage + support tickets ─────────────────────────────────────── */
  const signals = await seedProductAndSupportSignals(ctx, accountIds);
  console.log(
    `  ✓ ${signals.usageRows} daily usage rollups and ${signals.tickets} support tickets ingested`,
  );

  /* ── Relationship summaries + health ─────────────────────────────────────── */
  process.stdout.write('  … building customer memory');
  for (const [i, account] of accountIds.entries()) {
    await refreshAccountMemory(ctx, account.id);
    process.stdout.write(`\r  … building customer memory (${i + 1}/${accountIds.length})`);
  }
  for (const opportunityId of opportunityIds) {
    await refreshOpportunityMemory(ctx, opportunityId);
  }

  // Contact summaries only for the buying committees where there is real signal.
  const primaryContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.workspaceId} = ${workspaceId} AND ${contacts.buyingRole} IN ('champion', 'economic_buyer', 'technical_evaluator', 'blocker')`);
  for (const contact of primaryContacts) {
    await refreshContactMemory(ctx, contact.id);
  }
  console.log(`\r  ✓ memory built for ${accountIds.length} accounts, ${opportunityIds.length} deals, ${primaryContacts.length} contacts`);

  /* ── Agents ──────────────────────────────────────────────────────────────── */
  await seedAgents(ctx, workspaceId, ownerUserId, userIds);
  await seedAutomations(ctx, workspaceId, ownerUserId);

  /* ── Cross-account intelligence + inbox ──────────────────────────────────── */
  const insights = await computeInsights(ctx);
  console.log(`  ✓ ${insights.length} cross-account insights computed`);

  const inboxCount = await rebuildInbox(ctx);
  console.log(`  ✓ ${inboxCount} inbox items generated`);

  /* ── Summary ─────────────────────────────────────────────────────────────── */
  const counts = await tableCounts(db, workspaceId);
  console.log('\n✓ Seed complete in', ((Date.now() - started) / 1000).toFixed(1), 's\n');
  console.log('  Records created:');
  for (const [label, count] of counts) {
    console.log(`    ${label.padEnd(20)} ${count}`);
  }
  console.log('\n  Sign in at http://localhost:3000/login');
  console.log(`    email:    ${USERS[0]!.email}`);
  console.log(`    password: ${DEMO_PASSWORD}\n`);

  await handle.close();
}

/* ── Agents ───────────────────────────────────────────────────────────────── */

async function seedAgents(
  ctx: Ctx,
  workspaceId: string,
  ownerUserId: string,
  userIds: Map<string, string>,
): Promise<void> {
  const specs = [
    {
      name: 'At-Risk Deal Watch',
      description: 'Each weekday morning, finds the deals most likely to slip and explains what to do about each one.',
      prompt:
        'Every weekday morning, find my three most at-risk deals — anything above $25,000 with no customer activity for 10 days or more. Research what happened on each one and tell me what I should do next.',
      trigger: { kind: 'schedule' as const, cron: '0 8 * * 1-5', timezone: 'UTC', label: 'Weekdays, 08:00' },
      toolNames: ['search_opportunities', 'get_opportunity', 'get_recent_activity', 'search_emails', 'search_meetings', 'analyze_deal'],
      filters: { minValue: 25_000, inactiveDays: 10, status: 'open' },
      steps: [
        { id: 's1', kind: 'retrieve' as const, title: 'Find at-risk deals', detail: 'Open opportunities above $25k with 10+ days of customer silence.', tool: 'search_opportunities' },
        { id: 's2', kind: 'analyze' as const, title: 'Score each deal', detail: 'Recompute health and read the evidence behind each risk factor.', tool: 'analyze_deal' },
        { id: 's3', kind: 'retrieve' as const, title: 'Reconstruct what happened', detail: 'Read the most recent emails and meetings on each deal.', tool: 'get_recent_activity' },
        { id: 's4', kind: 'notify' as const, title: 'Report to the owner', detail: 'Post findings with evidence links to the Inbox.' },
      ],
      outputSchema: [
        { name: 'findings', type: 'string[]' as const, description: 'One line per at-risk deal with the recommended action.', required: true },
        { name: 'summary', type: 'string' as const, description: 'Short recap for the owner.', required: true },
      ],
      approvalPolicy: { autoApprove: ['low' as const], notify: 'record_owner' as const, expiresAfterHours: 48 },
      runAsKey: 'alex',
    },
    {
      name: 'Meeting Follow-Up',
      description: 'After a meeting is processed, drafts the follow-up email and turns commitments into tasks.',
      prompt:
        'Whenever a meeting is completed, summarise it, pull out what we committed to, and draft a follow-up email for the deal owner to review before sending.',
      trigger: { kind: 'event' as const, event: 'meeting.completed' },
      toolNames: ['search_meetings', 'search_transcripts', 'search_commitments', 'get_opportunity', 'draft_email', 'create_task'],
      filters: {},
      steps: [
        { id: 's1', kind: 'retrieve' as const, title: 'Read the meeting', detail: 'Pull the transcript and extracted commitments.', tool: 'search_transcripts' },
        { id: 's2', kind: 'analyze' as const, title: 'Identify what we owe', detail: 'Separate our commitments from theirs.', tool: 'search_commitments' },
        { id: 's3', kind: 'act' as const, title: 'Draft the follow-up', detail: 'Drafted only — sending needs human approval.', tool: 'draft_email' },
        { id: 's4', kind: 'act' as const, title: 'Create tasks for commitments', tool: 'create_task' },
      ],
      outputSchema: [
        { name: 'summary', type: 'string' as const, description: 'Meeting recap.', required: true },
        { name: 'findings', type: 'string[]' as const, description: 'Commitments and tasks created.', required: true },
      ],
      approvalPolicy: { autoApprove: ['low' as const], notify: 'record_owner' as const, expiresAfterHours: 72 },
      runAsKey: 'alex',
    },
    {
      name: 'Commitment Tracker',
      description: 'Watches promises we made and flags them before they come due.',
      prompt:
        'Every morning, check every commitment we made to a customer. Flag anything due in the next two days or already overdue, and create a task for the owner if one does not exist.',
      trigger: { kind: 'schedule' as const, cron: '0 7 * * 1-5', timezone: 'UTC', label: 'Weekdays, 07:00' },
      toolNames: ['search_commitments', 'get_account', 'get_opportunity', 'create_task'],
      filters: { direction: 'we_owe', dueWithinDays: 2 },
      steps: [
        { id: 's1', kind: 'retrieve' as const, title: 'Find commitments coming due', tool: 'search_commitments' },
        { id: 's2', kind: 'decide' as const, title: 'Check whether a task already exists' },
        { id: 's3', kind: 'act' as const, title: 'Create missing tasks', tool: 'create_task' },
      ],
      outputSchema: [
        { name: 'findings', type: 'string[]' as const, description: 'Commitments flagged.', required: true },
        { name: 'summary', type: 'string' as const, description: 'Recap.', required: true },
      ],
      approvalPolicy: { autoApprove: ['low' as const], notify: 'record_owner' as const, expiresAfterHours: 24 },
      runAsKey: 'sam',
    },
    {
      name: 'Pipeline Hygiene',
      description: 'Finds deals whose stage no longer matches what the conversations say.',
      prompt:
        'Weekly, review open deals and find any whose pipeline stage looks wrong based on recent conversations — for example still in Evaluation after pricing was shared. Propose the correct stage with evidence.',
      trigger: { kind: 'schedule' as const, cron: '0 9 * * 1', timezone: 'UTC', label: 'Mondays, 09:00' },
      toolNames: ['search_opportunities', 'get_opportunity', 'search_transcripts', 'search_emails', 'change_pipeline_stage'],
      filters: { status: 'open' },
      steps: [
        { id: 's1', kind: 'retrieve' as const, title: 'List open deals', tool: 'search_opportunities' },
        { id: 's2', kind: 'analyze' as const, title: 'Compare conversations to stage criteria', tool: 'search_transcripts' },
        { id: 's3', kind: 'act' as const, title: 'Propose stage changes', detail: 'Each change is proposed for approval, never applied silently.', tool: 'change_pipeline_stage' },
      ],
      outputSchema: [
        { name: 'findings', type: 'string[]' as const, description: 'Proposed stage changes with evidence.', required: true },
        { name: 'summary', type: 'string' as const, description: 'Recap.', required: true },
      ],
      approvalPolicy: { autoApprove: [], notify: 'record_owner' as const, expiresAfterHours: 96 },
      runAsKey: 'sam',
    },
  ];

  for (const spec of specs) {
    await ctx.db.insert(agents).values({
      workspaceId,
      name: spec.name,
      description: spec.description,
      prompt: spec.prompt,
      instructions: buildInstructions(spec.name, spec.prompt),
      trigger: spec.trigger,
      toolNames: spec.toolNames,
      steps: spec.steps,
      filters: spec.filters,
      outputSchema: spec.outputSchema,
      approvalPolicy: spec.approvalPolicy,
      runAsUserId: userIds.get(spec.runAsKey) ?? ownerUserId,
      maxRole: 'member',
      enabled: true,
      createdById: ownerUserId,
      nextRunAt: spec.trigger.kind === 'schedule' ? nextMorning() : null,
    });
  }
  console.log(`  ✓ ${specs.length} agents configured`);
}

function buildInstructions(name: string, prompt: string): string {
  return [
    `You are Bolt, running as the "${name}" agent in Figbolt. You operate only on records in this workspace.`,
    '',
    'What the user asked you to do:',
    prompt,
    '',
    'Rules:',
    '- Ground every claim in records you retrieved with tools. Cite them.',
    '- Never invent an account, contact, deal, number or date.',
    '- If the evidence is insufficient, report that rather than guessing.',
    '- Anything that changes data or leaves the workspace goes to human approval.',
    '- Be concise and specific. Name the record and the number.',
  ].join('\n');
}

async function seedAutomations(ctx: Ctx, workspaceId: string, ownerUserId: string): Promise<void> {
  await ctx.db.insert(automations).values([
    {
      workspaceId,
      name: 'Flag large deals going quiet',
      description: 'When an open deal above $50k has had no customer activity for 10 days, notify the owner.',
      trigger: { kind: 'event', event: 'opportunity.inactive' },
      conditions: {
        op: 'and',
        children: [
          { op: 'cmp', field: 'opportunity.value', comparator: 'gt', value: 50_000 },
          { op: 'cmp', field: 'opportunity.daysSinceActivity', comparator: 'gte', value: 10 },
          { op: 'cmp', field: 'opportunity.status', comparator: 'eq', value: 'open' },
        ],
      },
      actions: [
        {
          id: 'a1',
          kind: 'ask_ai',
          params: { question: 'What happened with this deal and what should the owner do next?' },
          riskLevel: 'low',
        },
        {
          id: 'a2',
          kind: 'create_task',
          params: { title: 'Re-engage {{opportunity.name}}', priority: 'high', dueInDays: 1 },
          riskLevel: 'medium',
        },
      ],
      enabled: true,
      createdById: ownerUserId,
    },
    {
      workspaceId,
      name: 'Process every completed meeting',
      description: 'Run meeting intelligence and prepare a follow-up whenever a meeting completes.',
      trigger: { kind: 'event', event: 'meeting.completed' },
      conditions: null,
      actions: [{ id: 'a1', kind: 'run_agent', params: { agentName: 'Meeting Follow-Up' }, riskLevel: 'low' }],
      enabled: true,
      createdById: ownerUserId,
    },
    {
      workspaceId,
      name: 'Alert on sentiment drop',
      description: 'When an account\'s sentiment turns negative, raise it in the Inbox for review.',
      trigger: { kind: 'event', event: 'account.sentiment_dropped' },
      conditions: { op: 'cmp', field: 'account.sentiment', comparator: 'lt', value: -0.2 },
      actions: [
        { id: 'a1', kind: 'add_note', params: { body: 'Sentiment turned negative — review recent conversations.' }, riskLevel: 'medium' },
      ],
      enabled: true,
      createdById: ownerUserId,
    },
  ]);
  console.log('  ✓ 3 automations configured');
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const EDGE_FOR_ROLE: Record<string, RelationshipType | undefined> = {
  champion: 'champion_for',
  decision_maker: 'decision_maker_for',
  economic_buyer: 'economic_buyer_for',
  technical_evaluator: 'technical_evaluator_for',
  blocker: 'blocker_for',
  influencer: 'relates_to',
  end_user: undefined,
  unknown: undefined,
};

const TASK_TEMPLATES: Record<string, { title: string; description?: string; priority: 'low' | 'normal' | 'high' | 'urgent'; dueInDays: number }[]> = {
  enterprise_security: [
    {
      title: 'Send security questionnaire + SOC 2 to {account}',
      description: 'Batch all four documents together — their security lead was explicit that piecemeal delivery stretches the review.',
      priority: 'high',
      dueInDays: 2,
    },
  ],
  stalled_after_pricing: [
    {
      title: 'Direct follow-up to {contact} on pricing',
      description: 'Two soft follow-ups have gone unanswered. Ask plainly whether the number is the blocker.',
      priority: 'urgent',
      dueInDays: 1,
    },
  ],
  pricing_pushback: [
    {
      title: 'Take platform licence option to CRO for {account}',
      description: 'Per-seat model is the objection at their headcount. Needs approval before it can be offered.',
      priority: 'high',
      dueInDays: 3,
    },
  ],
  competitive_bakeoff: [
    {
      title: 'Schedule working session with {account} team',
      description: 'Their own team builds a real workflow. This is the differentiation, not a feature comparison.',
      priority: 'high',
      dueInDays: 4,
    },
  ],
  integration_ask: [
    {
      title: 'Confirm Salesforce roadmap position for {account}',
      description: 'Do not commit a date. Product has not committed GA.',
      priority: 'normal',
      dueInDays: 5,
    },
  ],
  expansion: [
    { title: 'Send co-termed expansion proposal to {account}', priority: 'high', dueInDays: 2 },
  ],
  default: [
    { title: 'Follow up with {contact} at {account}', priority: 'normal', dueInDays: 3 },
  ],
};

function contactEmail(domain: string) {
  return (c: { firstName: string; lastName: string }) =>
    `${c.firstName.toLowerCase()}.${c.lastName.toLowerCase()}@${domain}`;
}

function influenceFor(seniority: string, buyingRole: string): number {
  const base = { c_level: 90, vp: 78, director: 62, manager: 45, ic: 28 }[seniority] ?? 40;
  const bump = { champion: 10, economic_buyer: 8, decision_maker: 8, blocker: 5 }[buyingRole] ?? 0;
  return Math.min(100, base + bump);
}

function extractHeading(chunk: string): string | null {
  const match = /^#{1,3}\s+(.+)$/m.exec(chunk);
  return match?.[1]?.trim() ?? null;
}

function nextMorning(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(8, 0, 0, 0);
  return d;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] ?? items[0]!;
}

async function tableCounts(
  db: Awaited<ReturnType<typeof import('@/db/client').getDb>>,
  workspaceId: string,
): Promise<[string, number][]> {
  const targets: [string, string][] = [
    ['accounts', 'accounts'],
    ['contacts', 'contacts'],
    ['opportunities', 'opportunities'],
    ['emails', 'emails'],
    ['meetings', 'meetings'],
    ['transcripts', 'transcripts'],
    ['notes', 'notes'],
    ['tasks', 'tasks'],
    ['commitments', 'commitments'],
    ['objections', 'objections'],
    ['product signals', 'product_signals'],
    ['memory facts', 'memory_facts'],
    ['timeline events', 'crm_events'],
    ['activities', 'activities'],
    ['embeddings', 'embeddings'],
    ['insights', 'insights'],
    ['notifications', 'notifications'],
    ['agents', 'agents'],
    ['automations', 'automations'],
    ['knowledge docs', 'knowledge_documents'],
    ['usage rollups', 'usage_daily'],
    ['support tickets', 'support_tickets'],
  ];

  const out: [string, number][] = [];
  for (const [label, table] of targets) {
    const result = (await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE workspace_id = ${workspaceId}`,
    )) as unknown as { rows: { n: number }[] };
    out.push([label, result.rows[0]?.n ?? 0]);
  }
  return out;
}

main().catch((err) => {
  console.error('\n✗ Seed failed:\n', err);
  process.exit(1);
});
