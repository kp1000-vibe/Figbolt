import { beforeAll, describe, expect, it } from 'vitest';
import { buildIcs, icsStamp, icsUid } from '@/server/calendar/ics';
import { getCalendarProvider } from '@/server/calendar/providers';
import { getTranscriptionProvider } from '@/server/meetings/transcribe';
import { ensureToolsLoaded } from '@/lib/agents/dispatch';
import { getTool } from '@/lib/agents/registry';

/**
 * Meeting scheduling, transcription and the actions that follow.
 *
 * The tests that matter here are not "does it schedule a meeting" — that needs
 * a database and a calendar. They are the three ways this feature could hurt
 * someone:
 *
 *   - a malformed .ics, which fails silently in Outlook and looks like the
 *     customer ignored you
 *   - a demo workspace writing to a real calendar because a default was wrong
 *   - an action derived from a customer's own words executing without review
 */

beforeAll(async () => {
  await ensureToolsLoaded();
});

/**
 * Undo RFC 5545 line folding, exactly as a real calendar client does before
 * parsing. Asserting against the folded text would make these tests fail
 * whenever a value happens to cross the 75-octet boundary, which is correct
 * output rather than a bug.
 */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '');
}

const BASE = {
  uid: 'mtg_123@figbolt.com',
  title: 'Discovery call',
  startsAt: new Date('2026-10-02T14:00:00Z'),
  endsAt: new Date('2026-10-02T14:30:00Z'),
  organizer: { email: 'alex@northwind.test', name: 'Alex Rivera' },
  attendees: [{ email: 'dana@acme.test', name: 'Dana Whitfield' }],
};

describe('the calendar invitation', () => {
  it('produces a parseable VEVENT with CRLF line endings', () => {
    const ics = buildIcs(BASE);

    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:mtg_123@figbolt.com');
    expect(ics).toContain('DTSTART:20261002T140000Z');
    expect(ics).toContain('DTEND:20261002T143000Z');
    expect(ics).toContain('SUMMARY:Discovery call');

    // Bare LF is rejected by some clients; every break must be CRLF.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('marks the organiser and every attendee', () => {
    const ics = unfold(buildIcs(BASE));
    expect(ics).toContain('ORGANIZER;CN=Alex Rivera:mailto:alex@northwind.test');
    expect(ics).toContain('mailto:dana@acme.test');
    expect(ics).toContain('RSVP=TRUE');
    expect(ics).toContain('CN=Dana Whitfield');
  });

  it('escapes the characters that would otherwise break the file', () => {
    const ics = buildIcs({
      ...BASE,
      title: 'Pricing; discounts, and terms',
      description: 'Line one\nLine two',
    });

    // A raw semicolon or comma in a TEXT value ends the value early.
    expect(unfold(ics)).toContain('SUMMARY:Pricing\\; discounts\\, and terms');
    expect(unfold(ics)).toContain('Line one\\nLine two');
  });

  it('folds long lines without splitting a multi-byte character', () => {
    // An emoji straddling the 75-octet boundary is the real-world version of
    // this bug: it renders fine in an ASCII test and corrupts in production.
    const ics = buildIcs({ ...BASE, title: `${'a'.repeat(70)}😀${'b'.repeat(40)}` });

    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // The character survives the fold intact.
    expect(unfold(ics)).toContain('😀');
  });

  it('can cancel the same event it created', () => {
    const cancel = buildIcs({ ...BASE, method: 'CANCEL', sequence: 1 });
    expect(cancel).toContain('METHOD:CANCEL');
    expect(cancel).toContain('STATUS:CANCELLED');
    expect(cancel).toContain('SEQUENCE:1');
    // Same UID, or the recipient's client treats it as an unrelated event.
    expect(cancel).toContain('UID:mtg_123@figbolt.com');
  });

  it('stamps times in UTC basic format', () => {
    expect(icsStamp(new Date('2026-01-05T09:07:03.412Z'))).toBe('20260105T090703Z');
  });

  it('builds a uid that is stable for a meeting', () => {
    expect(icsUid('mtg_abc')).toBe('mtg_abc@figbolt.com');
    expect(icsUid('mtg_abc')).toBe(icsUid('mtg_abc'));
  });
});

describe('nothing reaches a real calendar by default', () => {
  it('uses the console provider unless explicitly configured', () => {
    const provider = getCalendarProvider();
    expect(provider.name).toBe('console');
    // This is the guard that stops a demo workspace writing into a stranger's
    // Outlook. If it ever flips by default, that is a serious bug.
    expect(provider.delivers).toBe(false);
  });

  it('does not transcribe by default either', () => {
    expect(getTranscriptionProvider().transcribes).toBe(false);
  });
});

describe('scheduling is gated like the customer-facing action it is', () => {
  it('registers schedule_meeting as high risk with a preview', () => {
    const tool = getTool('schedule_meeting');
    expect(tool, 'schedule_meeting must be registered').toBeDefined();

    // It puts an event in an external person's calendar and emails them.
    expect(tool!.risk).toBe('high');
    expect(tool!.readOnly).toBe(false);
    expect(tool!.permission).toBe('meeting:manage');
    expect(typeof tool!.preview).toBe('function');
  });

  it('validates the payload it will act on', () => {
    const schema = getTool('schedule_meeting')!.input;

    const good = schema.safeParse({
      title: 'Discovery call',
      startsAt: '2026-10-02T14:00:00Z',
      durationMinutes: 30,
      attendeeEmails: ['dana@acme.test'],
    });
    expect(good.success, JSON.stringify(good.success ? {} : good.error.issues)).toBe(true);

    // No attendees is not a meeting.
    expect(schema.safeParse({
      title: 'Discovery call',
      startsAt: '2026-10-02T14:00:00Z',
      attendeeEmails: [],
    }).success).toBe(false);

    // A whole working week is not a meeting either.
    expect(schema.safeParse({
      title: 'Discovery call',
      startsAt: '2026-10-02T14:00:00Z',
      durationMinutes: 10_000,
      attendeeEmails: ['dana@acme.test'],
    }).success).toBe(false);
  });

  it('shows the approver the real time and the real invitee list', async () => {
    const tool = getTool('schedule_meeting')!;
    const preview = await tool.preview!(
      { ctx: { db: null } as never },
      {
        title: 'Discovery call',
        startsAt: '2026-10-02T14:00:00Z',
        durationMinutes: 30,
        attendeeEmails: ['dana@acme.test', 'priya@acme.test'],
      },
    );

    expect(preview.kind).toBe('text');
    const body = (preview as { body: string }).body;
    expect(body).toContain('Discovery call');
    expect(body).toContain('dana@acme.test');
    expect(body).toContain('priya@acme.test');
    // The approver must see when, not just what.
    expect(body).toMatch(/2 Oct 2026|Oct 2026|02 Oct 2026/);
  });
});

describe('meeting-derived actions cannot bypass review', () => {
  it('only ever proposes tools that carry a preview and are not read-only', async () => {
    // propose.ts may only emit these three. Each one mutates the CRM, so each
    // must be previewable — an approval screen that cannot render the effect
    // is an approval in name only.
    for (const name of ['add_note', 'create_task', 'draft_email']) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      expect(tool!.readOnly, name).toBe(false);
      expect(typeof tool!.preview, name).toBe('function');
    }
  });

  it('never proposes sending an email, only drafting one', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/meetings/propose.ts', 'utf8'),
    );

    // Drafting is reversible and MEDIUM; sending is neither. A meeting
    // transcript is untrusted input, so it must not be able to reach a
    // customer's inbox even through an approval.
    expect(source).not.toContain("'send_email'");
    expect(source).toContain("'draft_email'");
  });

  it('routes every proposal through createApproval and never through dispatchTool', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/meetings/propose.ts', 'utf8'),
    );

    // The load-bearing invariant of the whole feature: this module has exactly
    // one exit, and it is the approval queue.
    expect(source).toContain('createApproval');
    expect(source).not.toMatch(/\bdispatchTool\s*\(/);
  });
});
