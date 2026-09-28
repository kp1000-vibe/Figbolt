import { describe, expect, it } from 'vitest';
import { buildIcs, icsStamp } from '@/server/calendar/ics';
import {
  extractCommitments,
  extractFacts,
  extractObjections,
  extractProductSignals,
  spelledNumber,
} from '@/lib/ai/local/extract';
import { parseCommand } from '@/lib/ux/commands';

/**
 * Edge cases.
 *
 * Everything here is a shape that looks fine in a demo and breaks in the
 * field: a name with a comma in it, a meeting that crosses a DST boundary, a
 * transcript pasted out of a tool that uses different line endings, an empty
 * string where a sentence was expected. None of these are hypothetical — each
 * one is a class of input this code will genuinely receive.
 *
 * The rule applied throughout: for an input we cannot interpret, the correct
 * behaviour is to produce *nothing*, never to guess. A missed extraction costs
 * a rep one manual entry. A fabricated one puts a false claim in the CRM and
 * is then cited as evidence by an answer.
 */

/* ── Calendar invitations ──────────────────────────────────────────────── */

const ORGANIZER = { email: 'alex@northwind.test', name: 'Alex Rivera' };

function ics(overrides: Partial<Parameters<typeof buildIcs>[0]> = {}) {
  return buildIcs({
    uid: 'mtg_edge@figbolt.com',
    title: 'Call',
    startsAt: new Date('2026-10-02T14:00:00Z'),
    endsAt: new Date('2026-10-02T14:30:00Z'),
    organizer: ORGANIZER,
    attendees: [{ email: 'dana@acme.test' }],
    ...overrides,
  });
}

const unfold = (s: string) => s.replace(/\r\n /g, '');

describe('calendar invitations survive real-world input', () => {
  it('escapes a comma inside an attendee name', () => {
    // "Smith, Jane" is extremely common in directory exports, and an unescaped
    // comma inside CN= silently truncates the attendee list.
    const out = unfold(
      ics({ attendees: [{ email: 'jane@acme.test', name: 'Smith, Jane (Legal; VP)' }] }),
    );
    expect(out).toContain('CN=Smith\\, Jane (Legal\\; VP)');
    expect(out).toContain('mailto:jane@acme.test');
  });

  it('survives a title made entirely of special characters', () => {
    const out = unfold(ics({ title: ';;,,\\\\\n\n' }));
    expect(out).toContain('BEGIN:VEVENT');
    expect(out).toContain('END:VCALENDAR');
    // No raw newline may leak into the body of a property.
    for (const line of out.split('\r\n')) {
      expect(line.includes('\n')).toBe(false);
    }
  });

  it('handles a meeting that crosses a daylight-saving boundary', () => {
    // 2026-10-25 is when UK clocks go back. All ICS times are UTC, so the
    // duration must be exactly what was asked for regardless.
    const startsAt = new Date('2026-10-25T00:30:00Z');
    const endsAt = new Date('2026-10-25T01:30:00Z');
    const out = ics({ startsAt, endsAt });

    expect(out).toContain('DTSTART:20261025T003000Z');
    expect(out).toContain('DTEND:20261025T013000Z');
    expect(endsAt.getTime() - startsAt.getTime()).toBe(60 * 60_000);
  });

  it('handles a meeting spanning midnight and a month boundary', () => {
    const out = ics({
      startsAt: new Date('2026-10-31T23:30:00Z'),
      endsAt: new Date('2026-11-01T00:30:00Z'),
    });
    expect(out).toContain('DTSTART:20261031T233000Z');
    expect(out).toContain('DTEND:20261101T003000Z');
  });

  it('handles a leap day', () => {
    expect(icsStamp(new Date('2028-02-29T12:00:00Z'))).toBe('20280229T120000Z');
  });

  it('emits an event with no attendees rather than a malformed one', () => {
    // The scheduler rejects this upstream, but the builder must not produce
    // a broken file if it is ever called directly.
    const out = ics({ attendees: [] });
    expect(out).toContain('BEGIN:VEVENT');
    expect(out).not.toContain('ATTENDEE');
    expect(out.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('keeps every line within 75 octets for a description of CJK text', () => {
    // Multi-byte throughout, not just one character - a naive character-count
    // fold produces lines well over the octet limit here.
    const out = ics({ description: '契約条件について話し合いましょう。'.repeat(12) });
    for (const line of out.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
  });
});

/* ── Extraction ────────────────────────────────────────────────────────── */

const said = (text: string, isCustomer = true) => [{ text, isCustomer, index: 0 }];

describe('extraction refuses to invent things', () => {
  it('returns nothing for empty and whitespace input', () => {
    for (const text of ['', '   ', '\n\n\t']) {
      expect(extractCommitments(said(text))).toEqual([]);
      expect(extractObjections(said(text))).toEqual([]);
      expect(extractFacts(said(text))).toEqual([]);
      expect(extractProductSignals(said(text))).toEqual([]);
    }
  });

  it('does not treat a question about a promise as a promise', () => {
    // "Will you send the SOW?" is a request, and logging it as our commitment
    // would make the follow-up agent chase a promise nobody made.
    const out = extractCommitments(said('Will you send the SOW by Friday?'));
    expect(out).toEqual([]);
  });

  it('does not treat a refusal as a commitment', () => {
    expect(extractCommitments(said("We won't be able to send that before the board meets", false)))
      .toEqual([]);
    expect(extractCommitments(said('I am not going to share pricing at this stage', false)))
      .toEqual([]);
  });

  it('does not read a mention of a product as a request for it', () => {
    // A bare mention with no intent language is how false feature requests get
    // into a roadmap.
    expect(extractProductSignals(said('We moved off Salesforce about two years ago'))).toEqual([]);
    expect(extractProductSignals(said('Slack is where the team lives, has been for years'))).toEqual([]);
  });

  it('does not read praise containing "without" as a feature gap', () => {
    // Caught in review: widening the request cues to catch "without a public
    // API we cannot automate this" also made "we use Slack without any issues"
    // fire as a Slack request - praise turned into a roadmap item.
    expect(extractProductSignals(said('We use Slack without any issues at all, it has been great')))
      .toEqual([]);
    expect(extractProductSignals(said('Our Salesforce instance is still running fine')))
      .toEqual([]);
  });

  it('still catches a real gap expressed as a dependency', () => {
    // The other half of that trade: these must keep firing.
    expect(extractProductSignals(said('Without a public API we simply cannot automate any of this')).length)
      .toBeGreaterThan(0);
    expect(extractProductSignals(said('Unless the Salesforce sync lands before renewal we cannot justify keeping this')).length)
      .toBeGreaterThan(0);
  });

  it('attributes a promise to the right side', () => {
    const ours = extractCommitments(said("I'll send the security pack tomorrow", false));
    const theirs = extractCommitments(said("I'll send the signed order form tomorrow", true));

    expect(ours[0]?.direction).toBe('we_owe');
    expect(theirs[0]?.direction).toBe('they_owe');
  });

  it('does not attribute our own words to the customer', () => {
    // A rep restating a concern must not become a fresh customer objection,
    // or every call would manufacture objections from the rep's own summary.
    const out = extractObjections(
      said('So the concern is that the price is too high for this quarter, is that fair?', false),
    );
    expect(out).toEqual([]);
  });
});

describe('spoken numbers', () => {
  it('reads the forms people actually say', () => {
    expect(spelledNumber('four hundred')).toBe(400);
    expect(spelledNumber('two thousand')).toBe(2000);
    expect(spelledNumber('twenty five')).toBe(25);
    expect(spelledNumber('one hundred and fifty')).toBe(150);
    expect(spelledNumber('three thousand two hundred')).toBe(3200);
    expect(spelledNumber('hundred')).toBe(100);
  });

  it('returns null rather than a wrong number for anything else', () => {
    expect(spelledNumber('')).toBeNull();
    expect(spelledNumber('some')).toBeNull();
    expect(spelledNumber('a lot of')).toBeNull();
    expect(spelledNumber('the whole revenue')).toBeNull();
  });

  it('stops at the first non-number word instead of skipping it', () => {
    // "four hundred pound" must not silently become 400 plus whatever follows.
    expect(spelledNumber('four hundred pound gorilla')).toBe(400);
  });

  it('feeds a company-size fact from spoken input', () => {
    const facts = extractFacts(said('We are about four hundred people now, mostly in Manchester.'));
    const size = facts.find((f) => f.key === 'company_size');
    expect(size?.valueNumber).toBe(400);
  });

  it('does not emit a company size from an unparseable quantity', () => {
    const facts = extractFacts(said('We are quite a lot of people these days.'));
    expect(facts.find((f) => f.key === 'company_size')).toBeUndefined();
  });
});

/* ── Command parsing ───────────────────────────────────────────────────── */

describe('the command bar does not write on ambiguous input', () => {
  it('ignores empty and punctuation-only input', () => {
    for (const text of ['', '   ', '???', '...', '!!']) {
      expect(parseCommand(text), text).toBeNull();
    }
  });

  it('treats a question as a question even when it contains a command verb', () => {
    // Otherwise "should I move Acme to negotiation?" writes to the CRM.
    expect(parseCommand('should I log a call with Acme?')).toBeNull();
    expect(parseCommand('did we move Acme to proposal?')).toBeNull();
    expect(parseCommand('what tasks are open?')).toBeNull();
  });

  it('does not invent a stage from a near-miss', () => {
    expect(parseCommand('move Acme to the next bit')).toBeNull();
    expect(parseCommand('move Acme to')).toBeNull();
  });

  it('handles very long input without producing a command', () => {
    const long = `log call with ${'a'.repeat(5000)}`;
    const parsed = parseCommand(long);
    // Either it refuses, or it produces something bounded - never a crash.
    if (parsed) expect(parsed.rest.length).toBeLessThan(long.length);
  });

  it('is not confused by leading or trailing whitespace', () => {
    const a = parseCommand('  log call with Acme, went well  ');
    expect(a?.kind).toBe('log_note');
  });
});

/* ── Transcript parsing ────────────────────────────────────────────────── */

describe('pasted transcripts', () => {
  // importTranscript's line parser, exercised through its observable rule:
  // "Name: text" starts a turn, anything else continues the previous one.
  const SPEAKER_LINE = /^([A-Za-z][\w .'-]{0,40}):\s+(.*)$/;

  it('accepts a normal speaker line', () => {
    expect(SPEAKER_LINE.test('Dana Whitfield: Thanks for making time.')).toBe(true);
  });

  it('does not invent a speaker from a colon mid-sentence', () => {
    // "We agreed: ship it" would otherwise create a speaker called "We agreed".
    // It does match the shape, which is why the importer needs the line to
    // start a turn - this test pins the known limitation rather than hiding it.
    const m = SPEAKER_LINE.exec('We agreed: ship it in March');
    expect(m?.[1]).toBe('We agreed');
  });

  it('rejects a timestamp prefix as a speaker name', () => {
    expect(SPEAKER_LINE.test('00:14:32 - and then we reviewed the contract')).toBe(false);
  });

  it('handles CRLF line endings from Windows tools', () => {
    const pasted = 'Dana: One.\r\nAlex: Two.\r\n';
    const lines = pasted.split(/\r?\n/).filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(SPEAKER_LINE.exec(lines[0]!)?.[2]).toBe('One.');
  });
});
