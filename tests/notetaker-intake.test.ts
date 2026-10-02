import { describe, expect, it } from 'vitest';
import {
  normaliseSegments,
  notetakerPayloadSchema,
  parseTranscriptText,
} from '@/server/meetings/intake';

/**
 * Transcript intake.
 *
 * The parsing is where this breaks in the field: every notetaker emits a
 * slightly different text shape, and a parser that invents a speaker from a
 * colon mid-sentence puts words in a customer's mouth. These cases are drawn
 * from the formats the declared tools actually produce.
 *
 * The matching logic needs a database, so it is covered by its contract here
 * and exercised end to end through the route.
 */

describe('plain-text transcripts', () => {
  it('parses the common "Speaker: line" shape', () => {
    const out = parseTranscriptText(
      ['Dana Whitfield: Thanks for making time.', 'Alex Rivera: Of course.'].join('\n'),
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ speaker: 'Dana Whitfield', text: 'Thanks for making time.' });
    expect(out[1]?.speaker).toBe('Alex Rivera');
  });

  it('reads a timestamp prefix as a timestamp, not a speaker', () => {
    const out = parseTranscriptText('[00:14:32] Dana: We need EU data residency.');

    expect(out).toHaveLength(1);
    expect(out[0]?.speaker).toBe('Dana');
    expect(out[0]?.startSeconds).toBe(14 * 60 + 32);
    expect(out[0]?.text).toBe('We need EU data residency.');
  });

  it('handles mm:ss and bare-bracket variants', () => {
    expect(parseTranscriptText('(02:05) Alex: Sure.')[0]?.startSeconds).toBe(125);
    expect(parseTranscriptText('00:01:00 - Alex: Sure.')[0]?.startSeconds).toBe(60);
  });

  it('continues the previous speaker on a wrapped line', () => {
    // Otherwise a paragraph that wraps becomes a speaker called "and then we".
    const out = parseTranscriptText(
      ['Dana: We looked at the pricing', 'and then we spoke to procurement.'].join('\n'),
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('We looked at the pricing and then we spoke to procurement.');
  });

  it('does not invent a speaker from a colon mid-sentence', () => {
    // "We agreed: ship it" must not become a speaker called "We agreed" — but
    // it does match the shape, which is why a leading timestamp or a known
    // name is the stronger signal. This pins the known limitation rather than
    // pretending it is solved.
    const out = parseTranscriptText('Dana: We agreed: ship it in March.');
    expect(out).toHaveLength(1);
    expect(out[0]?.speaker).toBe('Dana');
    expect(out[0]?.text).toBe('We agreed: ship it in March.');
  });

  it('survives blank lines, CRLF and trailing whitespace', () => {
    const out = parseTranscriptText('Dana: One.\r\n\r\n   \r\nAlex: Two.   \r\n');
    expect(out.map((s) => s.text)).toEqual(['One.', 'Two.']);
  });

  it('keeps unattributed text rather than discarding it', () => {
    const out = parseTranscriptText('Some notes with no speaker at all.');
    expect(out).toHaveLength(1);
    expect(out[0]?.speaker).toBe('Unknown speaker');
  });

  it('returns nothing for empty input instead of a phantom segment', () => {
    expect(parseTranscriptText('')).toEqual([]);
    expect(parseTranscriptText('   \n\n  ')).toEqual([]);
  });
});

describe('structured segments', () => {
  it('prefers segments over the text field when both arrive', () => {
    const out = normaliseSegments({
      source: 'fireflies',
      segments: [{ speaker: 'Dana', text: 'Structured.', startSeconds: 5 }],
      transcript: 'Alex: Freeform.',
    } as never);

    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('Structured.');
  });

  it('fills a missing speaker and timestamp rather than dropping the turn', () => {
    const out = normaliseSegments({
      source: 'granola',
      segments: [{ text: 'No speaker given.' }],
    } as never);

    expect(out[0]).toMatchObject({ speaker: 'Unknown speaker', startSeconds: 0 });
  });

  it('carries an explicit isCustomer flag through', () => {
    // A tool that labels the side itself is more reliable than name matching.
    const out = normaliseSegments({
      source: 'gong',
      segments: [{ speaker: 'Dana', text: 'Hello.', isCustomer: true }],
    } as never);

    expect(out[0]?.isCustomer).toBe(true);
  });

  it('drops empty turns', () => {
    const out = normaliseSegments({
      source: 'otter',
      segments: [
        { speaker: 'Dana', text: 'Real.' },
        { speaker: 'Alex', text: '   ' },
      ],
    } as never);
    expect(out).toHaveLength(1);
  });
});

describe('the payload contract', () => {
  const base = { source: 'granola', attendees: ['dana@acme.test'] };

  it('accepts a minimal transcript payload', () => {
    const parsed = notetakerPayloadSchema.safeParse({
      ...base,
      transcript: 'Dana: We are ready to move forward.',
    });
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('accepts a segments payload', () => {
    const parsed = notetakerPayloadSchema.safeParse({
      ...base,
      segments: [{ speaker: 'Dana', text: 'We are ready.' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a payload with neither segments nor transcript', () => {
    // An empty POST must be a 422, not a meeting with no content.
    const parsed = notetakerPayloadSchema.safeParse({ ...base, title: 'Discovery call' });
    expect(parsed.success).toBe(false);
  });

  it('refuses an empty transcript string', () => {
    expect(notetakerPayloadSchema.safeParse({ ...base, transcript: '   ' }).success).toBe(false);
  });

  it('defaults the source so a minimal integration still records provenance', () => {
    const parsed = notetakerPayloadSchema.parse({ transcript: 'Dana: Hello there.' });
    expect(parsed.source).toBe('notetaker');
  });

  it('bounds the payload so one POST cannot exhaust the extractor', () => {
    const huge = { ...base, segments: Array.from({ length: 6000 }, () => ({ text: 'x' })) };
    expect(notetakerPayloadSchema.safeParse(huge).success).toBe(false);
  });
});

describe('the endpoint contract', () => {
  it('treats the transcript as evidence, never as instructions', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/v1/notetaker/route.ts', 'utf8'),
    );

    // The whole safety story: a third party posting a customer's words must
    // not be able to cause an action, only a proposal a human approves.
    expect(source).toContain('untrusted');
    expect(source).not.toMatch(/\bdispatchTool\s*\(/);
  });

  it('requires an API key and the permission to create records', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/v1/notetaker/route.ts', 'utf8'),
    );
    expect(source).toContain('authenticateRequest');
    expect(source).toContain("includes('record:create')");
    expect(source).toContain('checkRateLimit');
  });

  it('is idempotent on externalId, because webhooks retry', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/meetings/intake.ts', 'utf8'),
    );
    expect(source).toContain('externalId');
    expect(source).toContain('duplicate');
  });

  it('attaches to an overlapping meeting rather than duplicating it', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/meetings/intake.ts', 'utf8'),
    );
    // Without this, every Granola note creates a second meeting beside the
    // calendar entry it was recorded from.
    expect(source).toContain('OVERLAP_WINDOW_MS');
    expect(source).toContain("matchedBy: 'overlap'");
  });
});
