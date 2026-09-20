import type { EvidenceItem } from '../types';
import { bm25, buildTermStats, overlap, recencyWeight, selectSentences, tokenize, truncateWords } from './nlp';
import { detectCompetitors, extractCommitments, extractObjections, scoreSentiment } from './extract';

/**
 * Extractive answer composition for the offline engine.
 *
 * The design constraint is honesty: this engine cannot *write* new prose about
 * a customer, so it doesn't try. It finds the passages that actually answer the
 * question, quotes and stitches them, attributes each to its record, and states
 * plainly when the evidence is thin. An answer here is never more confident
 * than its sources — which is the same contract the hosted providers are held
 * to, just enforced mechanically.
 */

export type ComposedAnswer = {
  answer: string;
  confidence: number;
  usedRefs: number[];
  caveat?: string;
  reasoningSummary: string;
};

type ScoredPassage = {
  evidenceIndex: number;
  sentence: string;
  score: number;
  order: number;
};

export function composeAnswer(question: string, evidence: EvidenceItem[]): ComposedAnswer {
  if (evidence.length === 0) {
    return {
      answer:
        "I couldn't find any records matching that. Nothing in this workspace's emails, meetings, notes or CRM fields relates to the question, so there's nothing for me to summarise.",
      confidence: 0.15,
      usedRefs: [],
      caveat: 'No matching records.',
      reasoningSummary: 'Searched CRM records, conversations and knowledge; no matches.',
    };
  }

  const queryTerms = tokenize(question);
  const docs = evidence.map((e) => tokenize(e.content));
  const stats = buildTermStats(docs);

  const passages: ScoredPassage[] = [];
  let order = 0;

  evidence.forEach((item, evidenceIndex) => {
    const docScore = bm25(queryTerms, docs[evidenceIndex]!, stats);
    const recency = recencyWeight(
      item.ref.occurredAt ? new Date(item.ref.occurredAt) : undefined,
    );
    const retrieval = item.score ?? 0;

    for (const hit of selectSentences(item.content, queryTerms, 3)) {
      const sentence = cleanSentence(hit.sentence);
      // A passage that is just the record's own title tells the reader nothing
      // they didn't get from the citation header above it.
      if (sentence.split(/\s+/).length < 6) continue;
      if (isEchoOfLabel(sentence, item.ref.label)) continue;

      passages.push({
        evidenceIndex,
        sentence,
        // Blend sentence fit, document fit, retrieval rank and recency so a
        // single lucky keyword in an old note can't outrank a live thread.
        score: hit.score * 1.6 + docScore * 0.5 + retrieval * 1.1 + recency * 0.9,
        order: order++,
      });
    }
  });

  if (passages.length === 0) {
    // Terms didn't match any sentence: fall back to the most recent records so
    // the user still gets something real rather than a shrug.
    const recent = [...evidence]
      .sort((a, b) => (b.ref.occurredAt ?? '').localeCompare(a.ref.occurredAt ?? ''))
      .slice(0, 3);
    const lines = recent.map(
      (item, i) => `- ${item.ref.label}: ${truncateWords(firstMeaningful(item.content), 32)} [E${evidence.indexOf(item) + 1}]`,
    );
    return {
      answer: [
        "I didn't find anything that directly answers that, but here's the most recent related activity:",
        '',
        ...lines,
      ].join('\n'),
      confidence: 0.3,
      usedRefs: recent.map((r) => evidence.indexOf(r) + 1),
      caveat: 'No passage directly matched the question; showing recent related activity instead.',
      reasoningSummary: `Ranked ${evidence.length} records; no passage matched the query terms.`,
    };
  }

  /**
   * Prefer what people actually said over CRM field dumps.
   *
   * A structural record ("Industry: Manufacturing, Employees: 3200") often
   * scores well on term overlap but answers almost no real question. Boosting
   * conversation passages keeps the answer made of evidence a human would
   * recognise as an answer.
   */
  const weighted = passages.map((p) => ({
    ...p,
    score: p.score * (evidence[p.evidenceIndex]!.trust === 'untrusted' ? 1.25 : 0.85),
  }));

  const top = dedupePassages(weighted).slice(0, 6);
  const usedRefs = [...new Set(top.map((p) => p.evidenceIndex + 1))];
  const strength = top[0]!.score;
  const confidence = Math.max(0.25, Math.min(0.88, 0.3 + strength / 14));

  // Group passages by the record they came from, so the answer reads as
  // "here is what each conversation says" rather than a flat list.
  const byRecord = new Map<number, ScoredPassage[]>();
  for (const passage of top) {
    const existing = byRecord.get(passage.evidenceIndex);
    if (existing) existing.push(passage);
    else byRecord.set(passage.evidenceIndex, [passage]);
  }

  const grouped = [...byRecord.entries()]
    .sort((a, b) => Math.max(...b[1].map((p) => p.score)) - Math.max(...a[1].map((p) => p.score)))
    .map(([evidenceIndex, items]) => {
      const item = evidence[evidenceIndex]!;
      const when = item.ref.occurredAt ? ` · ${item.ref.occurredAt.slice(0, 10)}` : '';
      const body = items
        .sort((a, b) => a.order - b.order)
        .map((p) => p.sentence)
        .join(' ');
      return `**${item.ref.label}**${when} [E${evidenceIndex + 1}]\n${body}`;
    });

  const lead = leadSentence(question, evidence, usedRefs.length);

  const caveat =
    confidence < 0.5
      ? 'Evidence for this is thin — these are the closest matches rather than a definitive answer.'
      : undefined;

  return {
    answer: [lead, '', ...grouped].filter((x) => x !== undefined).join('\n\n'),
    confidence: Number(confidence.toFixed(2)),
    usedRefs,
    caveat,
    reasoningSummary: `Ranked ${evidence.length} retrieved records with BM25 and recency weighting, then quoted ${top.length} supporting passages from ${usedRefs.length} of them.`,
  };
}

/**
 * A one-line orientation before the quotes. The offline engine cannot write a
 * genuine synthesis, so this states plainly what the answer is assembled from
 * rather than pretending to summarise it.
 */
function leadSentence(question: string, evidence: EvidenceItem[], recordCount: number): string {
  const kinds = new Map<string, number>();
  for (const item of evidence) kinds.set(item.ref.type, (kinds.get(item.ref.type) ?? 0) + 1);

  const described = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${count} ${pluralise(type, count)}`)
    .join(', ');

  return `Here is what the records say, drawn from ${described}. The passages below are quoted directly — nothing here is inferred.`;
}

function pluralise(type: string, count: number): string {
  const label = type.replace(/_/g, ' ');
  if (count === 1) return label;
  return label.endsWith('y') ? `${label.slice(0, -1)}ies` : `${label}s`;
}

/* ── Record summaries ─────────────────────────────────────────────────────── */

export type RelationshipDigest = {
  relationship: string;
  currentPriorities: string[];
  customerGoals: string[];
  recentChanges: string[];
  knownRisks: string[];
  opportunities: string[];
  sentiment: number;
  competitors: string[];
};

/**
 * Build a relationship summary from raw interactions. Sections are populated
 * only when evidence supports them, so an empty "risks" list is a real signal
 * rather than a formatting artefact.
 */
export type DigestFacts = {
  /** Objections persisted against this subject. Authoritative — see below. */
  openConcernCount?: number;
  openConcernCategories?: string[];
  /**
   * The persisted objection summaries, already cleaned at extraction time.
   * Re-deriving risks from retrieved evidence pulls in the `From:`/`Subject:`
   * headers that retrieval prepends for the model's benefit, so the stored
   * rows are the only correct source for display.
   */
  openConcerns?: { category: string; summary: string }[];
  openCommitmentCount?: number;
};

/**
 * Build a relationship summary from raw interactions.
 *
 * Counts come from `facts` (the persisted rows) rather than from re-extracting
 * the retrieved evidence. Re-extraction sees only whatever the retriever
 * happened to return, so the summary would claim "no unresolved concerns"
 * on an account whose health score was being dragged down by six of them.
 */
export function composeRelationshipDigest(
  subjectName: string,
  evidence: EvidenceItem[],
  knownCompetitors: string[],
  facts: DigestFacts = {},
): RelationshipDigest {
  const corpus = evidence.map((e) => e.content).join('\n\n');
  const utterances = evidence.map((e) => ({
    text: e.content,
    isCustomer: e.metadata?.['isCustomer'] === true,
    speaker: typeof e.metadata?.['speaker'] === 'string' ? (e.metadata['speaker'] as string) : undefined,
  }));

  const objections = extractObjections(utterances);
  const goals = pickByCue(evidence, GOAL_CUES, 4);
  const priorities = pickByCue(evidence, PRIORITY_CUES, 4);
  const changes = recentHighlights(evidence, 4);

  const risks = (
    facts.openConcerns?.length
      ? facts.openConcerns.slice(0, 4)
      : objections.filter((o) => o.severity !== 'low').slice(0, 4)
  ).map((o) => `${labelForCategory(o.category)}: ${o.summary}`);

  const opportunities = pickByCue(evidence, EXPANSION_CUES, 3);

  const interactionCount = evidence.length;
  const latest = evidence
    .map((e) => e.ref.occurredAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);

  const daysSince = latest
    ? Math.floor((Date.now() - new Date(latest).getTime()) / 86_400_000)
    : null;

  // A readable sentence rather than a metrics string — this is the first thing
  // a person reads on the account page.
  const sentences: string[] = [
    `${interactionCount} recorded interaction${interactionCount === 1 ? '' : 's'} with ${subjectName}` +
      (daysSince !== null
        ? `, most recently ${daysSince === 0 ? 'today' : daysSince === 1 ? 'yesterday' : `${daysSince} days ago`}.`
        : '.'),
  ];

  if (goals.length > 0) {
    sentences.push(`They have described wanting to ${lowerFirst(stripLead(goals[0]!))}.`);
  }

  const concernCount = facts.openConcernCount ?? objections.length;
  const concernCategories =
    facts.openConcernCategories ??
    [...new Set(objections.map((o) => labelForCategory(o.category).toLowerCase()))];

  if (concernCount > 0) {
    sentences.push(
      `${concernCount} open concern${concernCount === 1 ? '' : 's'} on record` +
        (concernCategories.length > 0 ? ` (${concernCategories.slice(0, 3).join(', ')}).` : '.'),
    );
  } else if (interactionCount > 2) {
    sentences.push('No unresolved concerns have been recorded.');
  }

  if (facts.openCommitmentCount) {
    sentences.push(
      `${facts.openCommitmentCount} commitment${facts.openCommitmentCount === 1 ? '' : 's'} still open.`,
    );
  }

  const relationship = sentences.join(' ');

  return {
    relationship,
    currentPriorities: priorities,
    customerGoals: goals,
    recentChanges: changes,
    knownRisks: risks,
    opportunities,
    sentiment: scoreSentiment(corpus),
    competitors: detectCompetitors(corpus, knownCompetitors),
  };
}

const GOAL_CUES =
  /\b(we (?:want|need|are trying|'re trying) to|our goal|we're looking to|objective is|trying to (?:reduce|improve|increase|automate|consolidate)|hoping to|the aim is)\b/i;
const PRIORITY_CUES =
  /\b(priority|top of (?:the )?list|most important|critical|urgent|first thing|focus (?:this|next) quarter|before we can)\b/i;
const EXPANSION_CUES =
  /\b(other teams|another team|expand|additional seats|roll(?:ing)? out to|company-?wide|more licen[cs]es|second (?:team|department)|upsell|also interested)\b/i;

function pickByCue(evidence: EvidenceItem[], cue: RegExp, limit: number): string[] {
  const out: { text: string; when: string }[] = [];
  for (const item of evidence) {
    for (const sentence of item.content.split(/(?<=[.!?])\s+/)) {
      if (sentence.length < 20 || sentence.length > 260) continue;
      if (!cue.test(sentence)) continue;
      out.push({ text: cleanSentence(sentence), when: item.ref.occurredAt ?? '' });
    }
  }
  return out
    .sort((a, b) => b.when.localeCompare(a.when))
    .map((o) => o.text)
    .filter((text, i, arr) => arr.indexOf(text) === i)
    .slice(0, limit);
}

function recentHighlights(evidence: EvidenceItem[], limit: number): string[] {
  return [...evidence]
    .filter((e) => e.ref.occurredAt)
    .sort((a, b) => (b.ref.occurredAt ?? '').localeCompare(a.ref.occurredAt ?? ''))
    .slice(0, limit)
    .map((e) => `${e.ref.occurredAt!.slice(0, 10)} — ${e.ref.label}: ${truncateWords(firstMeaningful(e.content), 20)}`);
}

export function labelForCategory(category: string): string {
  const map: Record<string, string> = {
    price: 'Pricing',
    security: 'Security',
    compliance: 'Compliance',
    timing: 'Timing',
    competitor: 'Competition',
    integration: 'Integration',
    complexity: 'Complexity',
    authority: 'Approval',
    need: 'Fit',
    support: 'Support',
    other: 'Other',
  };
  return map[category] ?? category;
}

/* ── Email drafting ───────────────────────────────────────────────────────── */

export type DraftContext = {
  recipientFirstName: string;
  senderName: string;
  accountName: string;
  purpose: string;
  openCommitments: string[];
  openQuestions: string[];
  nextSteps: string[];
  lastMeetingTitle?: string;
  lastMeetingDate?: string;
};

/**
 * Compose a follow-up from what was actually said. Every line traces to a
 * recorded commitment, question or next step — the draft is never generic
 * filler, and if there is nothing to say it says so rather than padding.
 */
export function composeFollowUp(ctx: DraftContext): { subject: string; body: string } {
  const subject = ctx.lastMeetingTitle
    ? `Follow-up: ${ctx.lastMeetingTitle}`
    : `Following up — ${ctx.accountName}`;

  const lines: string[] = [`Hi ${ctx.recipientFirstName},`, ''];

  lines.push(
    ctx.lastMeetingDate
      ? `Thanks for the time on ${ctx.lastMeetingDate}. Recapping where we landed:`
      : 'Thanks for the time earlier. Recapping where we landed:',
  );
  lines.push('');

  if (ctx.openCommitments.length > 0) {
    lines.push('What we owe you:');
    for (const item of ctx.openCommitments.slice(0, 5)) lines.push(`  • ${item}`);
    lines.push('');
  }

  if (ctx.openQuestions.length > 0) {
    lines.push('Open questions from our side:');
    for (const q of ctx.openQuestions.slice(0, 3)) lines.push(`  • ${q}`);
    lines.push('');
  }

  if (ctx.nextSteps.length > 0) {
    lines.push('Proposed next steps:');
    for (const step of ctx.nextSteps.slice(0, 4)) lines.push(`  • ${step}`);
    lines.push('');
  }

  if (ctx.openCommitments.length === 0 && ctx.nextSteps.length === 0) {
    lines.push(
      `I wanted to check in on where things stand with ${ctx.accountName} and whether anything has changed on your side.`,
    );
    lines.push('');
  }

  lines.push('Anything I have wrong here, just say and I will correct it.');
  lines.push('');
  lines.push('Best,');
  lines.push(ctx.senderName);

  return { subject, body: lines.join('\n') };
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function cleanSentence(sentence: string): string {
  return sentence
    .replace(/\s+/g, ' ')
    .replace(/^[-•*\s]+/, '')
    .trim();
}

function firstMeaningful(content: string): string {
  // Structural evidence appends a `Source quote:` block for the model's
  // benefit. It is useful in a prompt and noise in a rendered highlight.
  const trimmed = content.split(/\n\s*Source quote:/i)[0] ?? content;
  const sentences = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim());
  return sentences.find((s) => s.length > 25) ?? sentences[0] ?? trimmed.slice(0, 160);
}

/** Drop passages that restate one another, keeping the strongest. */
function dedupePassages(passages: ScoredPassage[]): ScoredPassage[] {
  const sorted = [...passages].sort((a, b) => b.score - a.score);
  const kept: ScoredPassage[] = [];

  for (const candidate of sorted) {
    const terms = new Set(tokenize(candidate.sentence));
    if (terms.size === 0) continue;

    const duplicate = kept.some((k) => {
      const other = new Set(tokenize(k.sentence));
      let inter = 0;
      for (const t of terms) if (other.has(t)) inter++;
      return inter / (terms.size + other.size - inter) > 0.55;
    });
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

export { extractCommitments };

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Drop the cue phrase so a quoted goal reads as a clause. */
function stripLead(value: string): string {
  return value
    .replace(/^.*?\b(?:we (?:want|need|are trying|'re trying) to|our goal is|we're looking to|objective is|trying to|hoping to|the aim is)\s*/i, '')
    .replace(/[.]+$/, '')
    .trim();
}

/**
 * True when a candidate passage is essentially the record's own label, which
 * happens when a meeting has a title but little body text.
 */
function isEchoOfLabel(sentence: string, label: string): boolean {
  const stripped = label.replace(/^(?:Email|Meeting|Transcript|Note|Account|Deal|Commitment|Objection)\s*[—-]\s*/i, '');
  if (!stripped) return false;
  return overlap(sentence, stripped) > 0.6;
}
