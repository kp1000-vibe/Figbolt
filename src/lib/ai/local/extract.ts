import { splitSentences, tokenize, truncateWords } from './nlp';

/**
 * Rule-based extraction used by the offline engine.
 *
 * These are genuine linguistic extractors, not placeholders: modal-verb
 * commitment detection with owner/date resolution, cue-phrase objection
 * classification, and lexicon-driven product-signal matching. When a hosted
 * model is configured the same call sites use it instead — the *interface* is
 * the abstraction, so the product behaves the same either way, just with more
 * nuance from a real model.
 *
 * Every extraction carries a confidence, and the caller records the verbatim
 * quote it came from, so nothing here can produce an unsourced CRM fact.
 */

export type ExtractedCommitment = {
  description: string;
  direction: 'we_owe' | 'they_owe';
  ownerLabel: string;
  counterpartyLabel?: string;
  dueHint?: string;
  quote: string;
  segmentIndex?: number;
  confidence: number;
};

export type ExtractedObjection = {
  category: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
  quote: string;
  confidence: number;
};

export type ExtractedSignal = {
  category: string;
  title: string;
  detail: string;
  urgency: 'low' | 'medium' | 'high' | 'blocking';
  quote: string;
  confidence: number;
};

export type ExtractedChurnRisk = {
  present: boolean;
  summary: string;
  quote: string;
  confidence: number;
};

export type ExtractedFact = {
  key: string;
  label: string;
  valueText?: string;
  valueNumber?: number;
  unit?: string;
  quote: string;
  confidence: number;
};

export type Utterance = {
  text: string;
  speaker?: string;
  isCustomer?: boolean;
  index?: number;
};

/* ── Commitments ──────────────────────────────────────────────────────────── */

// Bare `can` and `plans` matched subordinate clauses ("before I can begin the
// review") far more often than real undertakings, so they are excluded.
const COMMIT_MODALS =
  /\b(will|'ll|shall|going to|gonna|plan to|planning to|intend to|plans to|plans on|commit to|promise to|agree to|agreed to|expects to)\b/i;
const COMMIT_VERBS =
  /\b(send|share|forward|provide|deliver|prepare|draft|schedule|set up|book|introduce|intro|loop in|follow up|circle back|get back|review|complete|sign|return|confirm|check|look into|put together|write up|walk through|demo|arrange|pull together|update|escalate|run|email)\b/i;
const HEDGES = /\b(might|maybe|possibly|perhaps|could probably|if we can|no promises|not sure)\b/i;
const NEGATION = /\b(won't|will not|can't|cannot|unable to|not going to)\b/i;

/**
 * Shapes that satisfy modal + action-verb but express a *requirement* rather
 * than an undertaking — "I need X before I can begin", "what I need is…".
 * Without this, every requirements email becomes a list of false commitments.
 */
const REQUEST_NOT_PROMISE =
  /\b(?:I|we)\s+(?:need|require|want)\b|\bbefore (?:I|we|you) can\b|\bcan you\b|\bcould you\b|\bplease\s+(?:send|share|provide|confirm)\b|\bthe following\b|\bwhat (?:I|we) need\b/i;

const DATE_HINT =
  /\b(today|tomorrow|tonight|end of (?:the )?(?:day|week|month|quarter)|EOD|EOW|COB|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (?:week|month|quarter|monday|tuesday|wednesday|thursday|friday)|this (?:week|afternoon|morning|month|friday|monday)|on (?:monday|tuesday|wednesday|thursday|friday)|within (?:\d+|a|two|three|four|five) (?:day|days|week|weeks|business days)|by (?:the )?\d{1,2}(?:st|nd|rd|th)?(?: of)? ?[a-z]*|in (?:\d+|a few|a couple of) (?:days|weeks)|by friday|by monday)\b/i;

const FIRST_PERSON = /\b(I|I'll|I'm|we|we'll|we're|our team|our|us|my)\b/i;

/**
 * Detect a promise and decide which side owes it.
 *
 * `direction` is resolved from the grammatical subject *and* who was speaking:
 * "I'll send the questionnaire" said by an internal rep is `we_owe`; the same
 * sentence from a customer contact is `they_owe`. Getting this backwards would
 * make the follow-up agent chase the wrong party, so an unclear subject drops
 * confidence rather than guessing.
 */
export function extractCommitments(utterances: Utterance[]): ExtractedCommitment[] {
  const found: ExtractedCommitment[] = [];

  for (const utt of utterances) {
    for (const sentence of splitSentences(utt.text)) {
      if (sentence.length < 12 || sentence.length > 400) continue;
      if (NEGATION.test(sentence)) continue;
      if (!COMMIT_MODALS.test(sentence) || !COMMIT_VERBS.test(sentence)) continue;
      // Questions state no obligation: "will you send the SOW?" is a request.
      if (/\?\s*$/.test(sentence) && !/\b(I|we)\b/i.test(sentence)) continue;
      // A request or a precondition is not a promise. "I need X before I can
      // begin" and "here's what I need:" both trip the modal+verb test.
      if (REQUEST_NOT_PROMISE.test(sentence)) continue;
      if (/:\s*$/.test(sentence.trim())) continue;
      if (/^\s*(?:\d+[.)]|[-•*])\s/.test(sentence)) continue;

      const subject = subjectOf(sentence);
      const speakerIsCustomer = utt.isCustomer === true;

      let direction: 'we_owe' | 'they_owe';
      let ownerLabel: string;
      let confidence = 0.62;

      if (subject.kind === 'first_person') {
        direction = speakerIsCustomer ? 'they_owe' : 'we_owe';
        ownerLabel = utt.speaker ?? (speakerIsCustomer ? 'Customer' : 'Our team');
        confidence += 0.18;
      } else if (subject.kind === 'named') {
        ownerLabel = subject.name;
        // A named third party is attributed by who is speaking about whom.
        direction = speakerIsCustomer ? 'they_owe' : 'we_owe';
        confidence += 0.12;
      } else {
        ownerLabel = utt.speaker ?? 'Unassigned';
        direction = speakerIsCustomer ? 'they_owe' : 'we_owe';
        confidence -= 0.12;
      }

      if (HEDGES.test(sentence)) confidence -= 0.2;
      const dueHint = DATE_HINT.exec(sentence)?.[0];
      if (dueHint) confidence += 0.12;
      if (utt.speaker) confidence += 0.05;

      found.push({
        description: normaliseCommitment(sentence, ownerLabel),
        direction,
        ownerLabel,
        dueHint,
        quote: sentence.trim(),
        segmentIndex: utt.index,
        confidence: clamp(confidence),
      });
    }
  }

  return dedupe(found, (c) => c.description.toLowerCase(), 0.55).filter((c) => c.confidence >= 0.45);
}

type Subject =
  | { kind: 'first_person' }
  | { kind: 'named'; name: string }
  | { kind: 'unknown' };

function subjectOf(sentence: string): Subject {
  const lead = sentence.trim().slice(0, 90);

  const named = /^(?:and\s+|so\s+|then\s+|ok(?:ay)?,?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:will|'ll|is going to|can|plans to|agreed to|said (?:he|she|they)(?:'ll| will))/.exec(
    lead,
  );
  if (named?.[1] && !/^(I|We|Our|The|This|That|It|They|You|Let)$/i.test(named[1])) {
    return { kind: 'named', name: named[1] };
  }
  if (FIRST_PERSON.test(lead)) return { kind: 'first_person' };
  return { kind: 'unknown' };
}

/**
 * Turn a spoken sentence into a task-shaped phrase.
 *
 * Subject rewriting has to handle contractions as whole tokens: replacing the
 * `I` inside `I'll` leaves "Alex Rivera'll send the report", which then shows
 * up verbatim on a task card. The alternation is ordered longest-first and the
 * contracted forms expand to "<owner> will".
 */
function normaliseCommitment(sentence: string, owner: string): string {
  const subject = owner === 'Our team' || owner === 'Unassigned' ? 'We' : owner;

  let s = sentence.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');

  // Strip discourse markers and leading punctuation, repeatedly: "Yes — I'll
  // send…" needs the marker removed *and then* the dash that it was hiding.
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    s = s
      .replace(/^[\s—–\-•*:,]+/, '')
      .replace(/^(?:and|so|then|ok(?:ay)?|well|right|sure|yeah|yes|honestly|actually|great|perfect|understood)\b[,\s]*/i, '')
      .trim();
    if (s === before) break;
  }

  s = s
    .replace(/^(I|We)['’]ll\b/, subject === 'We' ? 'We will' : `${subject} will`)
    .replace(/^(I|We)\s+(?:am|are)\s+going\s+to\b/i, `${subject} will`)
    .replace(/^(I|We)\b/, subject);

  // A trailing subordinate clause adds length without adding an action.
  s = s.replace(/,\s+(?:so|which|and then)\s+.*$/i, '');

  return truncateWords(s, 26);
}

/* ── Objections ───────────────────────────────────────────────────────────── */

const OBJECTION_RULES: {
  category: string;
  cues: RegExp;
  severity: 'low' | 'medium' | 'high';
}[] = [
  {
    category: 'price',
    cues: /\b(too expensive|out of (?:our )?budget|price is|pricing is|cost is|can't justify|cheaper|discount|budget (?:is|won't|doesn't)|sticker shock|expensive|cost concern)\b/i,
    severity: 'high',
  },
  {
    category: 'security',
    cues: /\b(soc\s?2|iso\s?27001|pen ?test|penetration test|security review|security questionnaire|vulnerability|data residency|encryption at rest|infosec|security team (?:needs|requires|has to))\b/i,
    severity: 'high',
  },
  {
    category: 'compliance',
    cues: /\b(gdpr|hipaa|ccpa|dpa|data processing agreement|compliance|legal review|privacy review|procurement (?:requires|needs))\b/i,
    severity: 'high',
  },
  {
    category: 'timing',
    cues: /\b(not right now|next quarter|next year|bad timing|revisit (?:in|next)|put (?:this|it) on hold|freeze|pause(?:d)? (?:this|the)|too early|circle back in)\b/i,
    severity: 'medium',
  },
  {
    category: 'competitor',
    cues: /\b(also (?:looking at|evaluating|considering)|comparing (?:you )?(?:to|with)|competitor|incumbent|already use|currently using|bake-?off|rfp)\b/i,
    severity: 'high',
  },
  {
    category: 'integration',
    cues: /\b(integrat\w+ (?:with|is|isn't)|doesn't (?:connect|integrate)|no (?:native )?integration|api (?:limitation|doesn't)|sync (?:issue|problem))\b/i,
    severity: 'medium',
  },
  {
    category: 'complexity',
    cues: /\b(too complex|complicated|steep learning curve|hard to (?:use|set ?up|deploy)|deployment complexity|migration (?:effort|risk|is)|change management|adoption risk|training burden)\b/i,
    severity: 'medium',
  },
  {
    category: 'authority',
    cues: /\b(need(?:s)? (?:sign-?off|approval)|have to (?:run|take) (?:this|it) (?:by|to)|not the decision|my boss|exec(?:utive)? (?:approval|sponsor)|board approval|cfo (?:needs|has))\b/i,
    severity: 'medium',
  },
  {
    category: 'need',
    // "We don't need to involve the board" is a blocker being *removed*, not
    // a lack of need, so the object of "need" has to be the offering itself.
    cues: /\b((?:don'?t|do not|doesn'?t) (?:really )?need (?:this|it|that|a |another|any |more\b)|not a priority|solving (?:this|it) (?:already|in-?house)|built (?:this|it) internally|nice to have)\b/i,
    severity: 'high',
  },
  {
    category: 'support',
    cues: /\b(support (?:is|was|response)|slow (?:to )?respond|sla|onboarding support|no dedicated)\b/i,
    severity: 'low',
  },
];

/**
 * Fragments that carry an objection *cue* without being an objection: our own
 * outbound restatements, enumerated document requests, and list intros. Left
 * unfiltered these flood the record — an email listing "1. SOC 2 report
 * 2. questionnaire" would otherwise land as two separate security objections.
 */
function isNonObjectionFragment(sentence: string): boolean {
  const s = sentence.trim();

  if (/^\s*(?:\d+[.)]|[-•*])\s/.test(s)) return true; // list item
  if (/:\s*$/.test(s)) return true; // list intro
  // A glued list: sentence splitting on "1. Report (current period) 2. Form"
  // leaves the next item's number stranded at either end.
  if (/\s\d+[.)]\s*$/.test(s) || /\s\d+[.)]\s+\S/.test(s)) return true;

  // Questions are enquiries, not objections. "Does it integrate with
  // Salesforce?" is a product signal; recording it as an objection as well
  // double-counts one utterance against deal health.
  if (/\?\s*$/.test(s)) return true;

  // Too short to state a position. "Our compliance team will ask." carries a
  // cue word but no actual concern.
  //
  // This replaces an earlier verb-whitelist check, which was too brittle to be
  // worth keeping: it rejected "we'll be comparing you side by side" because
  // `\bwill\b` does not match the contraction. Length plus the structural
  // filters above catch the same fragments without the false negatives.
  if (s.split(/\s+/).length < 9) return true;

  return false;
}

/**
 * Extract objections.
 *
 * Only the customer can raise an objection. A rep saying "I'll send the SOC 2
 * report" is *responding* to one, not making one — treating both as objections
 * double-counts every concern and corrupts the deal-health signal that depends
 * on the count.
 */
export function extractObjections(utterances: Utterance[]): ExtractedObjection[] {
  const found: ExtractedObjection[] = [];

  for (const utt of utterances) {
    if (utt.isCustomer !== true) continue;

    for (const sentence of splitSentences(utt.text)) {
      if (sentence.length < 20 || sentence.length > 420) continue;
      if (isNonObjectionFragment(sentence)) continue;

      for (const rule of OBJECTION_RULES) {
        if (!rule.cues.test(sentence)) continue;

        let confidence = 0.78;
        if (/\b(blocker|blocking|deal ?breaker|can't (?:move|proceed)|hard requirement|must have)\b/i.test(sentence)) {
          confidence += 0.12;
        }
        if (/\b(just|slightly|a (?:bit|little))\b/i.test(sentence)) confidence -= 0.1;

        const severity: 'low' | 'medium' | 'high' =
          /\b(blocker|blocking|deal ?breaker|hard requirement|can't (?:move|proceed|sign))\b/i.test(
            sentence,
          )
            ? 'high'
            : rule.severity;

        found.push({
          category: rule.category,
          summary: truncateWords(sentence.replace(/\s+/g, ' ').trim(), 28),
          severity,
          quote: sentence.trim(),
          confidence: clamp(confidence),
        });
        break;
      }
    }
  }

  return dedupe(found, (o) => `${o.category}:${o.summary.toLowerCase()}`, 0.6);
}

/* ── Product signals ──────────────────────────────────────────────────────── */

const REQUEST_CUES =
  /\b(need|needs|require|requires|required|would (?:love|like|need)|wish|hoping (?:for|to)|looking for|must have|it'd be (?:great|good)|any (?:plans|chance|way) (?:for|to)|do you (?:support|have)|is there (?:a|an|any)|can (?:it|you|we) (?:support|do)|blocker|deal ?breaker|missing)\b/i;

/** Canonical themes with aliases; new terms are learned by the theme matcher. */
export const SIGNAL_LEXICON: {
  slug: string;
  name: string;
  category: string;
  patterns: RegExp;
}[] = [
  { slug: 'sso', name: 'SSO / SAML', category: 'security_requirement', patterns: /\b(sso|single sign[- ]?on|saml|okta|azure ad|entra id|oidc)\b/i },
  { slug: 'scim', name: 'SCIM user provisioning', category: 'security_requirement', patterns: /\b(scim|user provisioning|auto[- ]?provisioning|deprovision)\b/i },
  { slug: 'soc2', name: 'SOC 2 attestation', category: 'security_requirement', patterns: /\b(soc\s?2|soc ?ii|type ?(?:i{1,2}|2))\b/i },
  { slug: 'audit-log', name: 'Audit logging', category: 'security_requirement', patterns: /\b(audit log|audit trail|activity log|access log)\b/i },
  { slug: 'salesforce-integration', name: 'Salesforce integration', category: 'integration_request', patterns: /\b(salesforce|sfdc)\b/i },
  { slug: 'hubspot-integration', name: 'HubSpot integration', category: 'integration_request', patterns: /\bhubspot\b/i },
  { slug: 'slack-integration', name: 'Slack integration', category: 'integration_request', patterns: /\bslack\b/i },
  { slug: 'zapier-integration', name: 'Zapier integration', category: 'integration_request', patterns: /\b(zapier|make\.com|workato)\b/i },
  { slug: 'snowflake-export', name: 'Snowflake / warehouse export', category: 'integration_request', patterns: /\b(snowflake|bigquery|redshift|data ?warehouse|reverse etl)\b/i },
  { slug: 'api-access', name: 'Public API', category: 'feature_request', patterns: /\b(public api|rest api|api access|webhooks?|graphql)\b/i },
  { slug: 'custom-fields', name: 'Custom fields & objects', category: 'feature_request', patterns: /\b(custom (?:field|object|propert)\w*)\b/i },
  { slug: 'mobile-app', name: 'Mobile app', category: 'feature_request', patterns: /\b(mobile app|ios app|android app|on my phone)\b/i },
  { slug: 'reporting', name: 'Advanced reporting', category: 'feature_request', patterns: /\b(custom report|advanced report|dashboard build|forecast report|bi tool)\b/i },
  { slug: 'bulk-import', name: 'Bulk import / migration', category: 'feature_request', patterns: /\b(bulk (?:import|upload|edit)|csv import|data migration)\b/i },
  { slug: 'permissions', name: 'Granular permissions', category: 'security_requirement', patterns: /\b(granular permission|field[- ]level (?:security|permission)|role[- ]based access|rbac)\b/i },
  { slug: 'data-residency', name: 'EU data residency', category: 'security_requirement', patterns: /\b(data residency|eu (?:hosting|region|data)|gdpr hosting|on[- ]?prem)\b/i },
  { slug: 'seat-pricing', name: 'Seat-based pricing concern', category: 'pricing_concern', patterns: /\b(per[- ]seat|seat (?:price|pricing|cost)|price per user|usage[- ]based pricing)\b/i },
];

export function extractProductSignals(utterances: Utterance[]): ExtractedSignal[] {
  const found: ExtractedSignal[] = [];

  for (const utt of utterances) {
    for (const sentence of splitSentences(utt.text)) {
      if (sentence.length < 12) continue;
      const requesty = REQUEST_CUES.test(sentence);

      for (const entry of SIGNAL_LEXICON) {
        if (!entry.patterns.test(sentence)) continue;
        // A bare mention is not a request; require intent language nearby.
        if (!requesty && !/\?\s*$/.test(sentence)) continue;

        const blocking =
          /\b(blocker|blocking|deal ?breaker|can't (?:go live|proceed|buy)|hard requirement|before (?:we|procurement) can)\b/i.test(
            sentence,
          );

        found.push({
          category: entry.category,
          title: entry.name,
          detail: truncateWords(sentence.replace(/\s+/g, ' ').trim(), 32),
          urgency: blocking ? 'blocking' : utt.isCustomer ? 'high' : 'medium',
          quote: sentence.trim(),
          confidence: clamp((utt.isCustomer ? 0.8 : 0.6) + (blocking ? 0.1 : 0)),
        });
      }
    }
  }

  return dedupe(found, (s) => `${s.title}:${s.detail.toLowerCase()}`, 0.65);
}

/* ── Churn risk ───────────────────────────────────────────────────────────── */

/**
 * Language that means "we might not continue".
 *
 * Two tiers, because they carry different weight. An explicit statement ("we
 * are not renewing") is near-certain; a conditional one ("hard to justify at
 * renewal") is a warning that still deserves a flag. Both are only trusted
 * from the customer's own words — us writing "if you churn" in an outbound
 * email is not a churn signal.
 */
const CHURN_EXPLICIT =
  /\b(?:(?:will |are |we'?re |do )?not (?:going to |gonna |be |planning to )?renew(?:ing)?|won'?t be renewing|cancel(?:ling|ing|lation)? (?:our |the |my )?(?:contract|subscription|account)|terminate (?:our|the) (?:contract|agreement)|moving to (?:a )?(?:another|different) (?:vendor|tool|provider)|end(?:ing)? our (?:contract|subscription))\b/i;

const CHURN_CONDITIONAL =
  /\b(?:reconsider(?:ing)? (?:at|come|the|our) renewal|hard to justify|cannot justify|can'?t justify|struggling to justify|questioning (?:the|its) value|evaluating (?:other|alternative) (?:vendors|options|tools)|looking at alternatives|gone back to (?:the |our )?(?:old|previous|spreadsheet)|going back to (?:the |our )?(?:old|previous|spreadsheet)|shelf ?ware|not getting (?:the )?value|renewal (?:is )?at risk)\b/i;

export function extractChurnRisk(utterances: Utterance[]): ExtractedChurnRisk {
  let best: ExtractedChurnRisk = { present: false, summary: '', quote: '', confidence: 0 };

  for (const utt of utterances) {
    // Only the customer can threaten to leave.
    if (utt.isCustomer !== true) continue;

    for (const sentence of splitSentences(utt.text)) {
      if (sentence.length < 15 || sentence.length > 420) continue;

      const explicit = CHURN_EXPLICIT.test(sentence);
      const conditional = CHURN_CONDITIONAL.test(sentence);
      if (!explicit && !conditional) continue;

      let confidence = explicit ? 0.88 : 0.68;
      // A named decision point makes it concrete rather than venting.
      if (/\b(?:renewal|renew|contract|procurement|end of (?:the )?(?:year|quarter))\b/i.test(sentence)) {
        confidence += 0.06;
      }
      if (/\b(?:might|maybe|possibly|could)\b/i.test(sentence)) confidence -= 0.08;

      if (confidence > best.confidence) {
        best = {
          present: true,
          summary: truncateWords(sentence.replace(/\s+/g, ' ').trim(), 24),
          quote: sentence.trim(),
          confidence: clamp(confidence),
        };
      }
    }
  }

  return best;
}

/* ── Structured facts ─────────────────────────────────────────────────────── */

const MONEY = /(?:\$|usd\s?)\s?([\d,]+(?:\.\d+)?)\s?([kmb])?\b|\b([\d,]+(?:\.\d+)?)\s?([kmb])\b(?=\s*(?:dollars|usd|budget|arr|acv))/gi;
const SEAT = /\b([\d,]{1,7})\s+(?:seats?|users?|licen[cs]es?|employees?)\b/i;

export function extractFacts(utterances: Utterance[]): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  for (const utt of utterances) {
    for (const sentence of splitSentences(utt.text)) {
      const lower = sentence.toLowerCase();

      // Budget / deal value
      if (/\b(budget|spend|invest|allocat|approved|acv|arr|contract value|price point)\b/.test(lower)) {
        const amount = firstMoney(sentence);
        if (amount !== null) {
          facts.push({
            key: 'budget',
            label: 'Expected budget',
            valueNumber: amount,
            unit: 'USD',
            quote: sentence.trim(),
            confidence: clamp(utt.isCustomer ? 0.82 : 0.68),
          });
        }
      }

      // Seat count
      const seats = SEAT.exec(sentence);
      if (seats?.[1] && /\b(need|want|have|start with|roll ?out|licen|seat|user)\b/.test(lower)) {
        facts.push({
          key: 'seat_count',
          label: 'Expected seats',
          valueNumber: Number(seats[1].replace(/,/g, '')),
          unit: 'seats',
          quote: sentence.trim(),
          confidence: 0.75,
        });
      }

      // Timeline
      if (/\b(go[- ]?live|launch|roll ?out|deploy|implement|in production|start(?:ing)? (?:by|in)|kick ?off)\b/.test(lower)) {
        const when = /\b(q[1-4](?:\s?(?:20)?\d{2})?|january|february|march|april|may|june|july|august|september|october|november|december|next (?:month|quarter|year)|end of (?:the )?(?:month|quarter|year)|in \d+ (?:weeks|months))\b/i.exec(
          sentence,
        );
        if (when?.[0]) {
          facts.push({
            key: 'timeline',
            label: 'Target timeline',
            valueText: when[0],
            quote: sentence.trim(),
            confidence: clamp(utt.isCustomer ? 0.78 : 0.62),
          });
        }
      }

      // Decision process
      if (/\b(decision|sign ?off|approv\w+|procurement|legal|security review|board)\b/.test(lower) && /\b(need|require|must|process|before)\b/.test(lower)) {
        facts.push({
          key: 'decision_process',
          label: 'Decision process',
          valueText: truncateWords(sentence.replace(/\s+/g, ' ').trim(), 26),
          quote: sentence.trim(),
          confidence: clamp(utt.isCustomer ? 0.74 : 0.58),
        });
      }
    }
  }

  return dedupe(facts, (f) => `${f.key}:${f.valueText ?? f.valueNumber}`, 0.7);
}

function firstMoney(text: string): number | null {
  MONEY.lastIndex = 0;
  const m = MONEY.exec(text);
  if (!m) return null;
  const digits = m[1] ?? m[3];
  const suffix = (m[2] ?? m[4] ?? '').toLowerCase();
  if (!digits) return null;
  const base = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  return base * mult;
}

/* ── Sentiment ────────────────────────────────────────────────────────────── */

const POSITIVE = /\b(great|excellent|love|excited|impressive|perfect|exactly|helpful|smooth|fantastic|works well|happy|pleased|looking forward|makes sense|strong|good fit|win)\b/gi;
const NEGATIVE = /\b(concern|concerned|worried|frustrat\w+|disappoint\w+|blocker|problem|issue|risk|slow|confusing|expensive|difficult|hard|unhappy|struggl\w+|delay\w*|stalled|painful|broken)\b/gi;
const INTENSIFIER = /\b(very|really|extremely|deeply|quite|incredibly)\b/gi;

/** Lexicon sentiment in [-1, 1], length-normalised. */
export function scoreSentiment(text: string): number {
  const pos = (text.match(POSITIVE) ?? []).length;
  const neg = (text.match(NEGATIVE) ?? []).length;
  if (pos + neg === 0) return 0;
  const intensity = 1 + Math.min((text.match(INTENSIFIER) ?? []).length * 0.1, 0.4);
  const raw = ((pos - neg) / (pos + neg)) * intensity;
  return Math.max(-1, Math.min(1, Number(raw.toFixed(3))));
}

export function detectCompetitors(text: string, known: string[]): string[] {
  const hits = new Set<string>();
  for (const name of known) {
    if (name.length < 3) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) hits.add(name);
  }
  // Generic phrasings that imply a competitor without naming a known one.
  if (/\b(the incumbent|our current (?:vendor|tool|provider)|another vendor)\b/i.test(text)) {
    hits.add('Unnamed incumbent');
  }
  return [...hits];
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

/** Keep the highest-confidence member of each near-duplicate cluster. */
function dedupe<T extends { confidence: number }>(
  items: T[],
  key: (item: T) => string,
  jaccardThreshold: number,
): T[] {
  const sorted = [...items].sort((a, b) => b.confidence - a.confidence);
  const kept: { item: T; terms: Set<string> }[] = [];
  const seen = new Set<string>();

  for (const item of sorted) {
    const k = key(item);
    if (seen.has(k)) continue;
    const terms = new Set(tokenize(k));

    const duplicate = kept.some(({ terms: other }) => {
      if (terms.size === 0 || other.size === 0) return false;
      let inter = 0;
      for (const t of terms) if (other.has(t)) inter++;
      return inter / (terms.size + other.size - inter) >= jaccardThreshold;
    });

    if (!duplicate) {
      kept.push({ item, terms });
      seen.add(k);
    }
  }
  return kept.map((k) => k.item);
}
