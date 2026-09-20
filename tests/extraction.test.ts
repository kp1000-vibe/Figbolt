import { describe, expect, it } from 'vitest';
import {
  extractCommitments,
  extractFacts,
  extractObjections,
  extractProductSignals,
  scoreSentiment,
  type Utterance,
} from '@/lib/ai/local/extract';

/**
 * These assert the extraction quality the memory engine depends on. A
 * regression here silently degrades every downstream surface — deal health,
 * the Inbox, product signals — so the bar is behavioural, not just "it ran".
 */

const transcript: Utterance[] = [
  {
    speaker: 'Alex Rivera',
    isCustomer: false,
    index: 0,
    text: "Thanks for making time. I'd love to walk through how the rollout would work for your team.",
  },
  {
    speaker: 'Priya Raman',
    isCustomer: true,
    index: 1,
    text: "Before we get into that — our security team needs SOC 2 Type II documentation. That's a hard requirement before procurement can even open a file.",
  },
  {
    speaker: 'Alex Rivera',
    isCustomer: false,
    index: 2,
    text: "Completely fair. I'll send the security questionnaire and our SOC 2 report by Friday.",
  },
  {
    speaker: 'Priya Raman',
    isCustomer: true,
    index: 3,
    text: 'We also need SSO with Okta before we can go live. Without single sign-on this is a blocker for us.',
  },
  {
    speaker: 'Priya Raman',
    isCustomer: true,
    index: 4,
    text: "Honestly the pricing is a concern too — at that number it's out of our budget for this fiscal year.",
  },
  {
    speaker: 'Alex Rivera',
    isCustomer: false,
    index: 5,
    text: 'Understood. What budget did you have approved?',
  },
  {
    speaker: 'Priya Raman',
    isCustomer: true,
    index: 6,
    text: 'We have about $120,000 approved for this, and we need roughly 250 seats to start.',
  },
  {
    speaker: 'Priya Raman',
    isCustomer: true,
    index: 7,
    text: "We're also evaluating Vantage Systems, so we'll be comparing you side by side.",
  },
  {
    speaker: 'Priya Raman',
    isCustomer: true,
    index: 8,
    text: 'Our goal is to go live by Q3 — we want to reduce the manual reporting work my team does every week.',
  },
  {
    speaker: 'Dana Okafor',
    isCustomer: true,
    index: 9,
    text: 'I will loop in our CFO next week so she can review the commercial terms.',
  },
  {
    speaker: 'Alex Rivera',
    isCustomer: false,
    index: 10,
    text: "I won't be able to change the list price, but I'll check what we can do on term length.",
  },
];

describe('commitment extraction', () => {
  const commitments = extractCommitments(transcript);

  it('finds the security questionnaire promise and attributes it to our side', () => {
    const match = commitments.find((c) => /questionnaire|soc 2/i.test(c.description));
    expect(match).toBeDefined();
    expect(match!.direction).toBe('we_owe');
    expect(match!.ownerLabel).toBe('Alex Rivera');
    expect(match!.dueHint?.toLowerCase()).toContain('friday');
    expect(match!.confidence).toBeGreaterThan(0.7);
  });

  it('attributes a customer promise to the customer side', () => {
    const match = commitments.find((c) => /cfo/i.test(c.description));
    expect(match).toBeDefined();
    expect(match!.direction).toBe('they_owe');
    expect(match!.dueHint?.toLowerCase()).toContain('next week');
  });

  it('keeps the verbatim quote so the commitment stays traceable', () => {
    for (const c of commitments) {
      expect(c.quote.length).toBeGreaterThan(10);
      expect(typeof c.segmentIndex).toBe('number');
    }
  });

  it('does not treat a negated statement as a commitment', () => {
    expect(commitments.some((c) => /won't be able to change the list price/i.test(c.quote))).toBe(
      false,
    );
  });

  it('does not invent commitments from small talk', () => {
    const smallTalk = extractCommitments([
      { speaker: 'A', isCustomer: false, index: 0, text: 'Great to meet you. How was your weekend?' },
    ]);
    expect(smallTalk).toHaveLength(0);
  });
});

describe('objection extraction', () => {
  const objections = extractObjections(transcript);

  it('classifies the security requirement', () => {
    const security = objections.find((o) => o.category === 'security');
    expect(security).toBeDefined();
    expect(security!.severity).toBe('high');
  });

  it('classifies the pricing pushback', () => {
    expect(objections.some((o) => o.category === 'price')).toBe(true);
  });

  it('classifies the competitive evaluation', () => {
    expect(objections.some((o) => o.category === 'competitor')).toBe(true);
  });

  it('weights customer-voiced objections above internal restatements', () => {
    const customerVoiced = objections.filter((o) => o.confidence >= 0.75);
    expect(customerVoiced.length).toBeGreaterThan(0);
  });
});

describe('product signal extraction', () => {
  const signals = extractProductSignals(transcript);

  it('detects SSO as a blocking requirement', () => {
    const sso = signals.find((s) => s.title === 'SSO / SAML');
    expect(sso).toBeDefined();
    expect(sso!.urgency).toBe('blocking');
    expect(sso!.category).toBe('security_requirement');
  });

  it('detects the SOC 2 requirement', () => {
    expect(signals.some((s) => s.title === 'SOC 2 attestation')).toBe(true);
  });

  it('ignores a bare mention with no request intent', () => {
    const noise = extractProductSignals([
      { speaker: 'A', isCustomer: true, index: 0, text: 'We use Slack internally for chat.' },
    ]);
    expect(noise).toHaveLength(0);
  });
});

describe('fact extraction', () => {
  const facts = extractFacts(transcript);

  it('parses a budget figure with its unit', () => {
    const budget = facts.find((f) => f.key === 'budget');
    expect(budget).toBeDefined();
    expect(budget!.valueNumber).toBe(120_000);
    expect(budget!.unit).toBe('USD');
  });

  it('parses seat count', () => {
    const seats = facts.find((f) => f.key === 'seat_count');
    expect(seats?.valueNumber).toBe(250);
  });

  it('parses a target timeline', () => {
    const timeline = facts.find((f) => f.key === 'timeline');
    expect(timeline?.valueText?.toLowerCase()).toContain('q3');
  });

  it('attaches a source quote to every fact', () => {
    expect(facts.every((f) => f.quote.length > 10)).toBe(true);
  });
});

describe('sentiment', () => {
  it('scores concern-heavy text negatively', () => {
    expect(
      scoreSentiment('I am worried about the delay and frustrated that support was slow.'),
    ).toBeLessThan(0);
  });

  it('scores enthusiastic text positively', () => {
    expect(scoreSentiment('This looks great — exactly what we need, really excited.')).toBeGreaterThan(
      0,
    );
  });

  it('returns neutral for text with no signal', () => {
    expect(scoreSentiment('The meeting is on Tuesday at 3pm.')).toBe(0);
  });
});

describe('objection false positives', () => {
  it('does not read "we do not need to involve the board" as an objection', () => {
    // A blocker being removed is the opposite of a concern; scoring it as one
    // dragged a healthy account's score down and put a buying signal in the
    // "open concerns" list.
    const found = extractObjections([
      {
        text: "I'll approve the budget on my side — I have discretion up to this level, so we don't need to involve the board.",
        isCustomer: true,
        index: 0,
      },
    ]);
    expect(found).toHaveLength(0);
  });

  it('still catches a real lack of need', () => {
    const found = extractObjections([
      {
        text: "Honestly, we don't need another tool — we already have three nobody opens.",
        isCustomer: true,
        index: 0,
      },
    ]);
    expect(found[0]?.category).toBe('need');
  });
});
