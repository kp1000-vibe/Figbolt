import {
  type CompletionRequest,
  type CompletionResult,
  type EvidenceItem,
  type LanguageModel,
  type StructuredRequest,
  type StructuredResult,
  type TaskKind,
} from '../types';
import { estimateTokens } from '../prompt';
import { composeAnswer, composeFollowUp, composeRelationshipDigest, labelForCategory } from '../local/compose';
import {
  detectCompetitors,
  extractChurnRisk,
  extractDefects,
  extractCommitments,
  extractFacts,
  extractObjections,
  extractProductSignals,
  scoreSentiment,
  type Utterance,
} from '../local/extract';
import { splitSentences, tokenize, truncateWords } from '../local/nlp';
import { coerceStructured } from './structured';

/**
 * The offline engine.
 *
 * This is not a stub or a fixture player. It performs real retrieval-grounded
 * work using the deterministic NLP in `../local/*`: extractive question
 * answering with citations, modal-verb commitment detection, cue-based
 * objection and product-signal classification, and evidence-weighted deal
 * scoring. It runs with no API key and no network.
 *
 * What it genuinely cannot do is generate fluent novel prose or reason about
 * situations its rules don't cover. It handles that by staying extractive and
 * declaring low confidence, rather than by inventing text — so the product's
 * "never fabricate CRM information" contract holds in offline mode too.
 *
 * Set `AI_PROVIDER=anthropic|openai|google` to swap in a hosted model; every
 * call site above this layer is unchanged.
 */
export class LocalModel implements LanguageModel {
  readonly provider = 'local' as const;
  readonly isRemote = false;
  readonly id = 'figbolt-offline-engine';

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const userText = lastUserMessage(request);
    const evidence = request.evidence ?? [];

    // Tool-calling path: used by the agent runtime. The planner is rule-based
    // and conservative — it only proposes tools whose required arguments it can
    // actually fill from the request, so it never fabricates ids.
    if (request.tools?.length && request.toolChoice !== 'none') {
      const planned = planToolCall(request, userText);
      if (planned) {
        return {
          text: '',
          toolCalls: [planned],
          stopReason: 'tool_use',
          usage: usageFor(request, ''),
          model: this.id,
        };
      }
      if (request.toolChoice === 'required') {
        // Caller demands a call but nothing is fillable; surface it honestly.
        return {
          text: '',
          toolCalls: [],
          stopReason: 'error',
          usage: usageFor(request, ''),
          model: this.id,
        };
      }
    }

    // Agent loop, final turn: the planner has nothing left to call, and what
    // the run actually learned is sitting in the tool results rather than in
    // `evidence`. Report those instead of answering "no records matched",
    // which was true of the retrieval index and false of the run.
    const toolReport = summariseToolResults(request);
    if (toolReport) {
      return {
        text: toolReport,
        toolCalls: [],
        stopReason: 'stop',
        usage: usageFor(request, toolReport),
        model: this.id,
      };
    }

    const composed = composeAnswer(userText, evidence);
    const text = composed.caveat ? `${composed.answer}\n\n_${composed.caveat}_` : composed.answer;

    return {
      text,
      toolCalls: [],
      stopReason: 'stop',
      usage: usageFor(request, text),
      model: this.id,
    };
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const value = runTask(request.task, request);
    const coerced = coerceStructured<T>(value, request);

    if (!coerced.ok) {
      throw new Error(`Offline engine produced an invalid result for ${request.task}: ${coerced.error}`);
    }
    return {
      value: coerced.value,
      usage: {
        promptTokens: estimateTokens(request.instruction) + evidenceTokens(request.evidence),
        completionTokens: estimateTokens(JSON.stringify(value)),
      },
      model: this.id,
      confidence: coerced.confidence,
    };
  }
}

/* ── Task dispatch ────────────────────────────────────────────────────────── */

function runTask(task: TaskKind, request: StructuredRequest<unknown>): Record<string, unknown> {
  const evidence = request.evidence ?? [];
  const utterances = toUtterances(evidence);

  switch (task) {
    case 'extract_commitments': {
      const items = extractCommitments(utterances);
      return {
        commitments: items.map((c) => ({
          description: c.description,
          direction: c.direction,
          ownerLabel: c.ownerLabel,
          dueHint: c.dueHint ?? '',
          quote: c.quote,
          segmentIndex: c.segmentIndex ?? -1,
          confidence: c.confidence,
        })),
        confidence: averageConfidence(items),
      };
    }

    case 'extract_objections': {
      const items = extractObjections(utterances);
      return {
        objections: items.map((o) => ({
          category: o.category,
          summary: o.summary,
          severity: o.severity,
          quote: o.quote,
          confidence: o.confidence,
        })),
        confidence: averageConfidence(items),
      };
    }

    case 'extract_product_signals': {
      // Lexicon signals name a wanted capability; defects are symptom-shaped
      // and need their own detector, or every bug in a ticket is dropped.
      const items = [...extractProductSignals(utterances), ...extractDefects(utterances)];
      // Ticket extraction asks for a churn verdict alongside the signals; a
      // sales transcript asks only for the signals and ignores the extra key.
      const churn = extractChurnRisk(utterances);
      return {
        signals: items.map((s) => ({
          category: s.category,
          title: s.title,
          detail: s.detail,
          urgency: s.urgency,
          quote: s.quote,
          confidence: s.confidence,
        })),
        churnRisk: churn,
        confidence: Math.max(averageConfidence(items), churn.confidence),
      };
    }

    case 'extract_facts': {
      const items = extractFacts(utterances);
      return {
        facts: items.map((f) => ({
          key: f.key,
          label: f.label,
          valueText: f.valueText ?? '',
          valueNumber: f.valueNumber ?? 0,
          unit: f.unit ?? '',
          quote: f.quote,
          confidence: f.confidence,
        })),
        confidence: averageConfidence(items),
      };
    }

    case 'summarize_meeting':
      return summarizeMeeting(request, utterances, evidence);

    case 'summarize_account':
    case 'summarize_contact':
      return summarizeRelationship(request, evidence);

    case 'summarize_opportunity':
      return summarizeOpportunity(request, evidence);

    case 'score_deal_health':
      return { ...readSignals(request), confidence: 0.7 };

    case 'draft_email':
      return draftEmail(request, evidence);

    case 'answer_question': {
      const composed = composeAnswer(request.instruction, evidence);
      return {
        answer: composed.answer,
        confidence: composed.confidence,
        citations: composed.usedRefs,
        recommendedActions: [],
        reasoningSummary: composed.reasoningSummary,
        caveat: composed.caveat ?? '',
      };
    }

    case 'classify_intent':
      return classifyIntent(request.instruction);

    case 'compile_agent':
    case 'plan_agent':
      return compileAgent(request.instruction);

    case 'suggest_stage':
      return suggestStage(request, evidence);

    case 'daily_briefing':
    case 'generate_insights':
    case 'build_icp':
    case 'analytics_query':
    default:
      // These surfaces compute their results in application code and use the
      // model only for narration; returning an empty envelope keeps them on
      // their deterministic path rather than inventing content.
      return { items: [], summary: '', confidence: 0.5 };
  }
}

/* ── Task implementations ─────────────────────────────────────────────────── */

function summarizeMeeting(
  request: StructuredRequest<unknown>,
  utterances: Utterance[],
  evidence: EvidenceItem[],
): Record<string, unknown> {
  const corpus = evidence.map((e) => e.content).join('\n');
  const objections = extractObjections(utterances);
  const signals = extractProductSignals(utterances);
  const sentiment = scoreSentiment(corpus);

  const decisions = matchSentences(
    utterances,
    /\b(we(?:'| a)?(?:ve)? (?:decided|agreed)|let's (?:go|move|do)|the plan is|we'll proceed|agreed to|sounds like a plan|deal)\b/i,
    4,
  );
  const pains = matchSentences(
    utterances,
    /\b(problem|pain|struggl\w+|frustrat\w+|manual|takes (?:us )?(?:too )?long|waste|bottleneck|inefficien\w+|can't (?:track|see|find))\b/i,
    5,
    true,
  );
  const questions = utterances
    .flatMap((u) => splitSentences(u.text).filter((s) => s.trim().endsWith('?')))
    .filter((q) => q.length > 15)
    .slice(0, 6)
    .map((q) => q.trim());
  const nextSteps = matchSentences(
    utterances,
    /\b(next step|follow up|we'll (?:send|schedule|set up|share)|action item|circle back|reconvene|touch base)\b/i,
    5,
  );
  const pricing = matchSentences(utterances, /\b(price|pricing|cost|quote|discount|budget|per seat|contract value)\b/i, 1);

  const sentimentLabel =
    sentiment > 0.25 ? 'positive' : sentiment < -0.25 ? 'negative' : objections.length > 1 ? 'mixed' : 'neutral';

  return {
    summary: buildMeetingSummary(request, decisions, pains, objections.length, nextSteps.length),
    keyDecisions: decisions,
    customerPains: pains,
    questions,
    objections: objections.map((o) => `${labelForCategory(o.category)}: ${o.summary}`),
    competitorsMentioned: detectCompetitors(corpus, readCompetitors(request)),
    pricingDiscussion: pricing[0] ?? '',
    productRequests: signals.map((s) => s.title),
    nextSteps,
    sentimentLabel,
    sentimentReason: buildSentimentReason(sentiment, objections.length, decisions.length),
    confidence: evidence.length > 0 ? 0.72 : 0.2,
  };
}

function buildMeetingSummary(
  request: StructuredRequest<unknown>,
  decisions: string[],
  pains: string[],
  objectionCount: number,
  nextStepCount: number,
): string {
  const title = readString(request, 'meetingTitle') || 'The meeting';
  const parts: string[] = [];

  parts.push(
    decisions.length > 0
      ? `${title} produced ${decisions.length} explicit decision${decisions.length === 1 ? '' : 's'}.`
      : `${title} was exploratory — no decisions were recorded.`,
  );
  if (pains.length > 0) parts.push(`The customer raised ${pains.length} pain point${pains.length === 1 ? '' : 's'}.`);
  if (objectionCount > 0) parts.push(`${objectionCount} objection${objectionCount === 1 ? '' : 's'} surfaced.`);
  parts.push(
    nextStepCount > 0
      ? `${nextStepCount} next step${nextStepCount === 1 ? '' : 's'} were agreed.`
      : 'No next steps were agreed, which is worth closing out.',
  );
  return parts.join(' ');
}

function buildSentimentReason(sentiment: number, objections: number, decisions: number): string {
  if (sentiment > 0.25) {
    return `Positive language dominated${decisions ? ` and ${decisions} decision(s) were reached` : ''}.`;
  }
  if (sentiment < -0.25) {
    return `Concern language outweighed positive signals${objections ? ` across ${objections} objection(s)` : ''}.`;
  }
  return objections > 0
    ? `Constructive overall, but ${objections} unresolved concern(s) keep it mixed.`
    : 'Tone was even, with no strong signals in either direction.';
}

function summarizeRelationship(
  request: StructuredRequest<unknown>,
  evidence: EvidenceItem[],
): Record<string, unknown> {
  const name = readString(request, 'subjectName') || 'This account';
  const digest = composeRelationshipDigest(name, evidence, readCompetitors(request), readDigestFacts(request));

  return {
    relationship: digest.relationship,
    currentPriorities: digest.currentPriorities,
    customerGoals: digest.customerGoals,
    recentChanges: digest.recentChanges,
    knownRisks: digest.knownRisks,
    opportunities: digest.opportunities,
    summary: digest.relationship,
    priorities: digest.currentPriorities,
    concerns: digest.knownRisks,
    confidence: evidence.length >= 3 ? 0.7 : 0.4,
  };
}

function summarizeOpportunity(
  request: StructuredRequest<unknown>,
  evidence: EvidenceItem[],
): Record<string, unknown> {
  const name = readString(request, 'subjectName') || 'This opportunity';
  const digest = composeRelationshipDigest(name, evidence, readCompetitors(request), readDigestFacts(request));
  const utterances = toUtterances(evidence);
  const objections = extractObjections(utterances);

  return {
    summary: digest.relationship,
    whyBuying: digest.customerGoals[0] ?? 'Not stated in the recorded conversations.',
    competitors: digest.competitors,
    objections: objections.map((o) => `${labelForCategory(o.category)}: ${o.summary}`),
    recentChanges: digest.recentChanges,
    missingInformation: missingInfo(request, digest),
    confidence: evidence.length >= 3 ? 0.68 : 0.4,
  };
}

function missingInfo(request: StructuredRequest<unknown>, digest: { customerGoals: string[] }): string[] {
  const gaps: string[] = [];
  const corpus = (request.evidence ?? []).map((e) => e.content).join(' ').toLowerCase();

  if (!/\b(budget|approved|acv|contract value)\b/.test(corpus)) gaps.push('No budget has been confirmed.');
  if (!/\b(go[- ]?live|timeline|launch|roll ?out|q[1-4])\b/.test(corpus)) gaps.push('No implementation timeline agreed.');
  if (!/\b(procurement|legal|sign ?off|approval|decision)\b/.test(corpus)) gaps.push('Decision process is undocumented.');
  if (digest.customerGoals.length === 0) gaps.push('The customer has not stated an explicit goal on record.');
  return gaps;
}

function draftEmail(
  request: StructuredRequest<unknown>,
  evidence: EvidenceItem[],
): Record<string, unknown> {
  const draft = composeFollowUp({
    recipientFirstName: readString(request, 'recipientFirstName') || 'there',
    senderName: readString(request, 'senderName') || 'The team',
    accountName: readString(request, 'accountName') || 'your team',
    purpose: readString(request, 'purpose') || 'follow up',
    openCommitments: readStrings(request, 'openCommitments'),
    openQuestions: readStrings(request, 'openQuestions'),
    nextSteps: readStrings(request, 'nextSteps'),
    lastMeetingTitle: readString(request, 'lastMeetingTitle') || undefined,
    lastMeetingDate: readString(request, 'lastMeetingDate') || undefined,
  });

  return { subject: draft.subject, body: draft.body, confidence: evidence.length > 0 ? 0.7 : 0.45 };
}

/** Route a natural-language request to the retrieval strategy that fits it. */
function classifyIntent(question: string): Record<string, unknown> {
  const q = question.toLowerCase();

  const intent = /\b(draft|write|compose|send|reply)\b/.test(q)
    ? 'draft'
    : /\b(create|add|update|move|change|set|assign|convert)\b/.test(q)
      ? 'mutate'
      : /\b(how many|count|total|trend|by month|average|conversion|rate|percent|breakdown|compare|which (?:industr|rep|segment))\b/.test(q)
        ? 'analytics'
        : /\b(why|what happened|summar|explain|status|blocking|blocked|risk|health)\b/.test(q)
          ? 'explain'
          : 'search';

  const scopes = new Set<string>();
  if (/\b(account|company|customer|logo)\b/.test(q)) scopes.add('accounts');
  if (/\b(contact|person|people|stakeholder|champion|buyer)\b/.test(q)) scopes.add('contacts');
  if (/\b(deal|opportunit|pipeline|close|forecast|stage)\b/.test(q)) scopes.add('opportunities');
  if (/\b(email|mail|thread|wrote|replied)\b/.test(q)) scopes.add('emails');
  if (/\b(meeting|call|demo|transcript|said|discussed)\b/.test(q)) scopes.add('meetings');
  if (/\b(task|todo|action item)\b/.test(q)) scopes.add('tasks');
  if (/\b(commit|promis|owe|agreed to)\b/.test(q)) scopes.add('commitments');
  if (/\b(objection|concern|pushback|worried|blocking|blocker)\b/.test(q)) scopes.add('objections');
  if (/\b(feature|request|asked for|integration|sso)\b/.test(q)) scopes.add('product_signals');
  if (/\b(playbook|pricing|security posture|documentation|battlecard)\b/.test(q)) scopes.add('knowledge');

  /**
   * Naming a record type narrows *which* records matter, never where the
   * evidence lives. "What's blocking the Acme deal?" is answered by transcripts
   * and email, not by the opportunity row — so the conversation scopes are
   * always included for anything but a pure analytics question.
   */
  if (intent !== 'analytics') {
    scopes.add('emails');
    scopes.add('meetings');
    scopes.add('transcripts');
    scopes.add('notes');
  }
  if (intent === 'explain') {
    scopes.add('accounts');
    scopes.add('opportunities');
    scopes.add('commitments');
    scopes.add('objections');
  }

  return {
    intent,
    scopes: [...scopes],
    timeframeDays: /\b(\d+)\s*(?:day|days)\b/.exec(q)?.[1]
      ? Number(/\b(\d+)\s*(?:day|days)\b/.exec(q)![1])
      : /\b(90|ninety)\b/.test(q)
        ? 90
        : /\b(quarter|q[1-4])\b/.test(q)
          ? 90
          : /\b(month)\b/.test(q)
            ? 30
            : /\b(week)\b/.test(q)
              ? 7
              : 0,
    confidence: 0.75,
  };
}

/** Turn an agent description into a trigger/filter/tool/step plan. */
function compileAgent(description: string): Record<string, unknown> {
  const d = description.toLowerCase();

  const timeMatch = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(d);
  const hour = timeMatch
    ? (Number(timeMatch[1]) % 12) + (timeMatch[3] === 'pm' ? 12 : 0)
    : /\bmorning\b/.test(d)
      ? 8
      : /\bevening\b/.test(d)
        ? 17
        : 9;
  const minute = timeMatch?.[2] ? Number(timeMatch[2]) : 0;

  const weekdays = /\b(weekday|every weekday|monday to friday|business day)\b/.test(d);
  const weekly = /\b(every week|weekly|each week|every monday)\b/.test(d);
  const isScheduled = weekdays || weekly || /\b(every (?:day|morning)|daily|each morning|each day|nightly)\b/.test(d);

  const trigger = isScheduled
    ? {
        kind: 'schedule',
        cron: `${minute} ${hour} * * ${weekdays ? '1-5' : weekly ? '1' : '*'}`,
        timezone: 'UTC',
      }
    : /\b(when|whenever|after) (?:a |an )?(meeting|call)\b/.test(d)
      ? { kind: 'event', event: 'meeting.completed' }
      : /\b(when|whenever|after) (?:an? )?email\b/.test(d)
        ? { kind: 'event', event: 'email.received' }
        : /\b(when|whenever) .*stage\b/.test(d)
          ? { kind: 'event', event: 'opportunity.stage_changed' }
          : { kind: 'manual' };

  const valueMatch = /\$\s?([\d,]+)\s?(k|m)?/.exec(d);
  const minValue = valueMatch
    ? Number(valueMatch[1]!.replace(/,/g, '')) *
      (valueMatch[2] === 'k' ? 1000 : valueMatch[2] === 'm' ? 1_000_000 : 1)
    : undefined;
  const inactiveMatch = /(\d+)\s*days?(?:\s*(?:of|with|without|no))?/.exec(d);
  const inactiveDays =
    /\b(inactiv|no (?:customer )?(?:activity|contact|response)|gone (?:quiet|dark)|stale|haven't heard)\b/.test(d) &&
    inactiveMatch
      ? Number(inactiveMatch[1])
      : undefined;

  const tools = new Set<string>(['search_opportunities', 'get_opportunity', 'get_recent_activity']);
  if (/\b(email|inbox|wrote|correspond)\b/.test(d)) tools.add('search_emails');
  if (/\b(meeting|call|transcript|said)\b/.test(d)) tools.add('search_meetings');
  if (/\b(account|company|customer)\b/.test(d)) tools.add('search_accounts');
  if (/\b(contact|stakeholder|champion|person)\b/.test(d)) tools.add('search_contacts');
  if (/\b(draft|write|compose|email them|reach out)\b/.test(d)) tools.add('draft_email');
  if (/\b(task|todo|action item|create a task)\b/.test(d)) tools.add('create_task');
  if (/\b(note|log|record a note)\b/.test(d)) tools.add('add_note');
  if (/\b(update|set|change|move .* to)\b/.test(d)) tools.add('update_record');
  if (/\b(stage|pipeline)\b/.test(d)) tools.add('change_pipeline_stage');
  if (/\b(report|analy[sz]|summar|research|why)\b/.test(d)) tools.add('analyze_deal');
  if (/\b(knowledge|playbook|battlecard|documentation)\b/.test(d)) tools.add('search_knowledge');

  const steps: Record<string, unknown>[] = [
    {
      id: 'step_find',
      kind: 'retrieve',
      title: 'Find matching records',
      detail: [
        minValue ? `Opportunity value above $${minValue.toLocaleString()}` : null,
        inactiveDays ? `No customer activity for ${inactiveDays}+ days` : null,
        !minValue && !inactiveDays ? 'Records matching the described criteria' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      tool: 'search_opportunities',
    },
    {
      id: 'step_context',
      kind: 'analyze',
      title: 'Review what happened',
      detail: 'Read recent emails, meetings and timeline events for each match.',
      tool: 'get_recent_activity',
    },
  ];

  if (tools.has('draft_email')) {
    steps.push({
      id: 'step_draft',
      kind: 'act',
      title: 'Draft an email for the owner to review',
      detail: 'Drafted, never sent — external sending requires explicit approval.',
      tool: 'draft_email',
    });
  }
  if (tools.has('create_task')) {
    steps.push({ id: 'step_task', kind: 'act', title: 'Create follow-up tasks', tool: 'create_task' });
  }
  steps.push({
    id: 'step_notify',
    kind: 'notify',
    title: 'Report findings to the owner',
    detail: 'Post the summary with evidence links to the Inbox.',
  });

  const name = deriveAgentName(description);

  return {
    name,
    description: truncateWords(description.replace(/\s+/g, ' ').trim(), 40),
    instructions: buildAgentInstructions(description),
    trigger,
    toolNames: [...tools],
    steps,
    filters: {
      ...(minValue ? { minValue } : {}),
      ...(inactiveDays ? { inactiveDays } : {}),
      ...(/\b(open|active)\b/.test(d) ? { status: 'open' } : {}),
    },
    outputSchema: [
      { name: 'findings', type: 'string[]', description: 'One line per record acted on.', required: true },
      { name: 'summary', type: 'string', description: 'Short recap for the owner.', required: true },
    ],
    approvalPolicy: {
      // Anything with external reach starts gated regardless of phrasing.
      autoApprove: tools.has('draft_email') || tools.has('update_record') ? ['low'] : ['low', 'medium'],
      notify: 'record_owner',
      expiresAfterHours: 48,
    },
    confidence: 0.7,
  };
}

function deriveAgentName(description: string): string {
  const d = description.toLowerCase();
  if (/\bat[- ]risk|risk\b/.test(d)) return 'At-Risk Deal Watch';
  if (/\bstale|inactiv|gone (?:quiet|dark)|no (?:activity|contact)\b/.test(d)) return 'Stalled Deal Monitor';
  if (/\bfollow[- ]?up\b/.test(d)) return 'Follow-Up Assistant';
  if (/\bcommit/.test(d)) return 'Commitment Tracker';
  if (/\bprospect|icp|similar (?:to|companies)\b/.test(d)) return 'Prospecting Agent';
  if (/\bbrief|morning|digest\b/.test(d)) return 'Daily Briefing';
  if (/\bmeeting\b/.test(d)) return 'Meeting Follow-Up';
  const words = description.split(/\s+/).slice(0, 4).join(' ').replace(/[^\w\s-]/g, '');
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : 'Custom Agent';
}

function buildAgentInstructions(description: string): string {
  return [
    'You are Bolt, running as an agent in Figbolt. Operate only on records in this workspace.',
    '',
    'What the user asked you to do:',
    description.trim(),
    '',
    'Rules:',
    '- Ground every claim in records you retrieved. Cite them.',
    '- Never invent an account, contact, deal, number or date.',
    '- If the evidence is insufficient, report that instead of guessing.',
    '- Anything that leaves the workspace (email, external message) must go to approval.',
  ].join('\n');
}

function suggestStage(
  request: StructuredRequest<unknown>,
  evidence: EvidenceItem[],
): Record<string, unknown> {
  const corpus = evidence.map((e) => e.content).join(' ').toLowerCase();
  const signals: { stage: string; cues: RegExp; why: string }[] = [
    { stage: 'Negotiation', cues: /\b(contract|redline|msa|terms|legal review|procurement|sign(?:ature|ing)?|order form|discount)\b/, why: 'Contract and procurement language is present.' },
    { stage: 'Proposal', cues: /\b(proposal|quote|pricing (?:doc|sheet)|sow|statement of work|sent (?:over )?(?:the )?pricing)\b/, why: 'A proposal or pricing document has been shared.' },
    { stage: 'Evaluation', cues: /\b(security review|technical (?:evaluation|review)|poc|pilot|trial|questionnaire|architecture review)\b/, why: 'A formal evaluation is under way.' },
    { stage: 'Discovery', cues: /\b(discovery|intro call|learn more|current process|tell us about)\b/, why: 'Conversation is still exploratory.' },
  ];

  const match = signals.find((s) => s.cues.test(corpus));
  return {
    suggestedStage: match?.stage ?? '',
    reason: match?.why ?? 'No stage-defining language found in recent conversations.',
    confidence: match ? 0.62 : 0.25,
  };
}

/* ── Rule-based tool planner ──────────────────────────────────────────────── */

/**
 * Decide the next tool call for an agent run.
 *
 * Only proposes a tool when every required argument can be filled from the
 * request itself. That constraint is what keeps the offline engine from
 * inventing record ids — it would rather stop than guess.
 */
function planToolCall(
  request: CompletionRequest,
  userText: string,
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  const tools = request.tools ?? [];
  const alreadyCalled = new Set(
    request.messages
      .flatMap((m) => ('toolCalls' in m ? m.toolCalls : []))
      .map((c) => c.name),
  );

  const available = tools.filter((t) => !alreadyCalled.has(t.name));
  if (available.length === 0) return null;

  const q = userText.toLowerCase();
  const preference = [
    /\bopportunit|deal|pipeline\b/.test(q) ? 'search_opportunities' : null,
    /\baccount|company\b/.test(q) ? 'search_accounts' : null,
    /\bcontact|person|stakeholder\b/.test(q) ? 'search_contacts' : null,
    /\bemail\b/.test(q) ? 'search_emails' : null,
    /\bmeeting|call|transcript\b/.test(q) ? 'search_meetings' : null,
    'search_opportunities',
    'search_accounts',
  ].filter((x): x is string => Boolean(x));

  const chosen =
    available.find((t) => preference.includes(t.name)) ??
    available.find((t) => t.name.startsWith('search_') || t.name.startsWith('get_'));

  if (!chosen) return null;

  // An agent's task message is structured: an identity line, the original
  // request, and the filters a human configured in the agent builder. Those
  // filters are the most reliable thing in the whole message — someone typed
  // them deliberately — so they fill tool arguments wherever the names match.
  const configured = configuredFilters(userText);
  const ask = originalRequest(userText);

  const args: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(chosen.parameters.properties)) {
    const required = chosen.parameters.required?.includes(key) ?? false;

    const fromConfig = configured[key];
    if (fromConfig !== undefined && matchesType(fromConfig, prop)) {
      args[key] = fromConfig;
      continue;
    }

    if (key === 'query' || key === 'q') {
      // A whole instruction ("Each weekday morning, find the deals most likely
      // to slip…") makes a terrible search query — it matches nothing and the
      // run reports an empty workspace. Only pass a query when the request
      // actually names something; otherwise leave it out and let the filters
      // do the work.
      const focus = searchFocus(ask);
      if (focus) args[key] = focus;
      else if (required) return null;
    } else if (key === 'limit') {
      args[key] = 15;
    } else if (
      key === 'status' &&
      prop.enum?.includes('open') &&
      !/\b(won|lost|closed)\b/i.test(ask)
    ) {
      // The overwhelmingly common intent for an agent sweep is live records.
      args[key] = 'open';
    } else if (prop.enum?.length && required) {
      args[key] = prop.enum[0];
    } else if (required) {
      // A required argument we cannot fill honestly — abandon this tool.
      return null;
    }
  }

  return { id: `local_${alreadyCalled.size + 1}`, name: chosen.name, arguments: args };
}

/**
 * The user's actual ask, separated from the runtime's framing.
 *
 * The agent runtime labels its task message with `Original request:`. Without
 * this the planner reads the framing — including the agent's own quoted name —
 * as if it were something to search for.
 */
function originalRequest(text: string): string {
  const match = /Original request:\s*([\s\S]*?)(?:\n\s*(?:Configured filters|Trigger payload):|$)/i.exec(
    text,
  );
  return (match?.[1] ?? text).trim();
}

/** Filters a human configured on the agent, as `- key: jsonValue` lines. */
function configuredFilters(text: string): Record<string, unknown> {
  const block = /Configured filters:\s*\n([\s\S]*?)(?:\n\s*\n|$)/i.exec(text);
  if (!block?.[1]) return {};

  const out: Record<string, unknown> = {};
  for (const line of block[1].split('\n')) {
    const entry = /^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line);
    if (!entry?.[1] || !entry[2]) continue;
    try {
      out[entry[1]] = JSON.parse(entry[2].trim());
    } catch {
      out[entry[1]] = entry[2].trim();
    }
  }
  return out;
}

/** Whether a configured value is usable for a declared parameter. */
function matchesType(value: unknown, prop: { type?: string; enum?: readonly string[] }): boolean {
  if (prop.enum?.length) return typeof value === 'string' && prop.enum.includes(value);
  if (prop.type === 'number' || prop.type === 'integer') return typeof value === 'number';
  if (prop.type === 'boolean') return typeof value === 'boolean';
  if (prop.type === 'string') return typeof value === 'string';
  if (prop.type === 'array') return Array.isArray(value);
  return false;
}

/**
 * The searchable part of a request, if there is one.
 *
 * Quoted phrases and proper nouns are the signal that a human meant a specific
 * record. Everything else — "find the deals most likely to slip" — is a
 * description of a job, and searching for it returns nothing.
 */
function searchFocus(text: string): string | null {
  const quoted = /["“']([^"”']{3,60})["”']/.exec(text);
  if (quoted?.[1]) return quoted[1];

  // Proper nouns, ignoring a capital that is only there because it starts a
  // sentence or names a weekday.
  const IGNORE = new Set([
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'each', 'every', 'when', 'find', 'the', 'figbolt', 'crm', 'ai', 'run',
  ]);
  const proper = [...text.matchAll(/(?:^|[^.!?]\s)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)/g)]
    .map((m) => m[1]!.trim())
    .filter((n) => !IGNORE.has(n.toLowerCase()));

  if (proper.length > 0) return proper.slice(0, 2).join(' ');
  return null;
}

/* ── Request helpers ──────────────────────────────────────────────────────── */

function toUtterances(evidence: EvidenceItem[]): Utterance[] {
  return evidence.map((item, index) => ({
    text: item.content,
    speaker: typeof item.metadata?.['speaker'] === 'string' ? (item.metadata['speaker'] as string) : undefined,
    isCustomer: item.metadata?.['isCustomer'] === true,
    index: typeof item.metadata?.['segmentIndex'] === 'number' ? (item.metadata['segmentIndex'] as number) : index,
  }));
}

/**
 * Turn the run's tool results into the agent's report.
 *
 * Offline this is a rendering job rather than a writing one: each tool already
 * returned a one-line summary written by its author, plus structured rows. The
 * engine lists those and pulls out the records the tool itself flagged — low
 * health, long silence, stuck in stage, awaiting approval. Nothing is inferred
 * that a tool did not report.
 */
function summariseToolResults(request: CompletionRequest): string | null {
  const results = request.messages.filter((m) => m.role === 'tool');
  if (results.length === 0) return null;

  const lines: string[] = [];
  const notable: string[] = [];
  let pending = 0;

  for (const message of results) {
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content) continue;

    const [summary = '', ...rest] = content.split('\n\n');

    if (/NOT performed/i.test(content)) {
      pending++;
      lines.push(`- ${summary.trim()}`);
      continue;
    }

    lines.push(`- **${message.name ?? 'tool'}** — ${summary.trim()}`);

    // The structured half, when it is a list of records, is where the
    // actionable detail lives.
    for (const row of extractNotableRows(rest.join('\n\n'))) {
      if (notable.length < 8 && !notable.includes(row)) notable.push(row);
    }
  }

  if (lines.length === 0) return null;

  const parts = ['Here is what the run found.', '', ...lines];

  if (notable.length > 0) {
    parts.push('', 'Worth attention:', ...notable.map((n) => `- ${n}`));
  }
  if (pending > 0) {
    parts.push(
      '',
      `${pending} proposed action${pending === 1 ? ' is' : 's are'} awaiting human approval and ${
        pending === 1 ? 'has' : 'have'
      } NOT been performed.`,
    );
  }
  parts.push(
    '',
    '_Reported by the offline engine: these are the tool results as returned, not a written analysis._',
  );

  return parts.join('\n');
}

/** Pull out records a tool itself flagged as needing attention. */
function extractNotableRows(payload: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.replace(/…\[truncated\]$/, ''));
  } catch {
    return [];
  }

  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (Object.values(parsed as Record<string, unknown>).find((v): v is unknown[] =>
          Array.isArray(v),
        ) ?? [])
      : [];

  const out: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name =
      typeof r['name'] === 'string' ? r['name'] : typeof r['title'] === 'string' ? r['title'] : null;
    if (!name) continue;

    const flags: string[] = [];
    if (typeof r['health'] === 'number' && r['health'] < 50) flags.push(`health ${r['health']}/100`);
    if (typeof r['daysSinceContact'] === 'number' && r['daysSinceContact'] >= 14) {
      flags.push(`no contact for ${r['daysSinceContact']} days`);
    }
    if (typeof r['daysInStage'] === 'number' && r['daysInStage'] >= 30) {
      flags.push(`${r['daysInStage']} days in stage`);
    }
    if (r['status'] === 'overdue' || r['overdue'] === true) flags.push('overdue');

    if (flags.length > 0) {
      const account = typeof r['account'] === 'string' ? ` (${r['account']})` : '';
      out.push(`${name}${account} — ${flags.join(', ')}`);
    }
  }
  return out;
}

function lastUserMessage(request: CompletionRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i]!;
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content) return msg.content;
  }
  return '';
}

/**
 * The structured-request instruction carries a small `key: value` preamble that
 * hosted models read as prose; offline we parse it directly.
 */
function readString(request: StructuredRequest<unknown>, key: string): string {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im');
  return re.exec(request.instruction)?.[1]?.trim() ?? '';
}

function readStrings(request: StructuredRequest<unknown>, key: string): string[] {
  const block = new RegExp(`^\\s*${key}\\s*:\\s*\\n((?:\\s*[-•]\\s*.+\\n?)+)`, 'im').exec(
    request.instruction,
  );
  if (!block?.[1]) {
    const inline = readString(request, key);
    return inline ? inline.split(/\s*[;|]\s*/).filter(Boolean) : [];
  }
  return block[1]
    .split('\n')
    .map((l) => l.replace(/^\s*[-•]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Persisted counts the caller passes in the instruction preamble. The summary
 * must agree with the health rationale, and only the caller has the
 * authoritative numbers.
 */
function readDigestFacts(request: StructuredRequest<unknown>) {
  const num = (key: string) => {
    const raw = readString(request, key);
    const n = Number(raw);
    return Number.isFinite(n) && raw !== '' ? n : undefined;
  };
  const categories = readString(request, 'openConcernCategories');

  // The caller serialises persisted objections as `category|summary` lines.
  // Using those verbatim keeps the displayed risks identical to the stored
  // rows, rather than re-deriving them from retrieval-formatted text.
  const concerns = readStrings(request, 'openConcerns')
    .map((line) => {
      const [category, ...rest] = line.split('|');
      return { category: (category ?? 'other').trim(), summary: rest.join('|').trim() };
    })
    .filter((c) => c.summary.length > 0);

  return {
    openConcernCount: num('openConcernCount'),
    openConcernCategories: categories
      ? categories.split(/\s*,\s*/).filter(Boolean)
      : undefined,
    openConcerns: concerns.length > 0 ? concerns : undefined,
    openCommitmentCount: num('openCommitmentCount'),
  };
}

function readCompetitors(request: StructuredRequest<unknown>): string[] {
  const fromContext = /competitors?\s*:\s*(.+)/i.exec(request.workspaceContext ?? '')?.[1];
  const fromInstruction = readString(request, 'knownCompetitors');
  return [fromContext, fromInstruction]
    .filter((x): x is string => Boolean(x))
    .flatMap((s) => s.split(/\s*[,;|]\s*/))
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function readSignals(request: StructuredRequest<unknown>): Record<string, unknown> {
  // Deal health is computed deterministically in `src/server/intelligence/health.ts`;
  // the model layer only ever narrates that result.
  return { positives: [], risks: [], score: 50, method: 'deterministic' };
}

function matchSentences(
  utterances: Utterance[],
  cue: RegExp,
  limit: number,
  customerOnly = false,
): string[] {
  const out: string[] = [];
  for (const utt of utterances) {
    if (customerOnly && utt.isCustomer === false) continue;
    for (const sentence of splitSentences(utt.text)) {
      if (sentence.length < 18 || sentence.length > 300) continue;
      if (cue.test(sentence)) out.push(sentence.replace(/\s+/g, ' ').trim());
    }
  }
  return [...new Set(out)].slice(0, limit);
}

function averageConfidence(items: { confidence: number }[]): number {
  if (items.length === 0) return 0.5;
  return Number((items.reduce((sum, i) => sum + i.confidence, 0) / items.length).toFixed(2));
}

function evidenceTokens(evidence: EvidenceItem[] | undefined): number {
  return (evidence ?? []).reduce((sum, e) => sum + estimateTokens(e.content), 0);
}

function usageFor(request: CompletionRequest, output: string): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens:
      estimateTokens(request.system) +
      request.messages.reduce((sum, m) => sum + estimateTokens('content' in m ? m.content : ''), 0) +
      evidenceTokens(request.evidence),
    completionTokens: estimateTokens(output),
  };
}
