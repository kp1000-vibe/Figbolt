import type { LearningTask } from '@/db/schema';

/**
 * Commands the command bar can *execute*, not just navigate to.
 *
 * The command bar could previously only `router.push`, so every write still
 * cost navigate → find the record → open a modal → fill it → submit. That is
 * the "too many clicks for a simple daily update" complaint, and it applied
 * here too.
 *
 * Parsing is deliberately rule-based rather than model-driven. A rep typing
 * "call acme went well" at 5pm needs the same result every time, in under a
 * frame, offline, with no token spend — and a misfire that silently writes the
 * wrong record is worse than no shortcut at all. Anything ambiguous falls
 * through to Ask, which is safe because Ask only reads.
 *
 * Every command dispatches a registered agent tool, so the shortcut inherits
 * the same permission check, risk class, approval gate and audit row as the
 * long way round. There is no fast path that skips the gate.
 */

export type CommandKind =
  | 'log_note'
  | 'create_task'
  | 'move_stage'
  | 'draft_email'
  | 'create_account'
  | 'create_contact';

export type ParsedCommand = {
  kind: CommandKind;
  /** The agent tool this dispatches. */
  tool: string;
  /** What the row should read, once a target is bound. */
  label: string;
  /** The free text left after the verb — the note body, task title, etc. */
  rest: string;
  /** A stage name, when the verb implied one. */
  stage?: string;
  /** A due date in days, when the text named one. */
  dueInDays?: number;
  /** True when the command cannot run without an account or deal. */
  needsTarget: boolean;
  /** A name the user typed that should be used to create, not to search. */
  newName?: string;
  /** Risk class, so the UI can say "this will need approval" up front. */
  risk: 'low' | 'medium' | 'high';
  /**
   * How it runs. `tool` dispatches through the agent tool dispatcher;
   * `draft_endpoint` composes text via /api/draft and hands it to the
   * composer, because draft_email needs real recipients and a body that a
   * one-line command cannot supply.
   */
  via: 'tool' | 'draft_endpoint';
};

const STAGES = [
  'discovery',
  'evaluation',
  'proposal',
  'negotiation',
  'closed won',
  'closed lost',
];

/** Weekday and relative-date words a rep actually types. */
const WHEN: [RegExp, number][] = [
  [/\btoday\b/i, 0],
  [/\btonight\b/i, 0],
  [/\btomorrow\b/i, 1],
  [/\bnext week\b/i, 7],
  [/\bin (\d+) days?\b/i, -1], // captured below
  [/\bmonday\b/i, -2],
  [/\btuesday\b/i, -2],
  [/\bwednesday\b/i, -2],
  [/\bthursday\b/i, -2],
  [/\bfriday\b/i, -2],
  [/\bsaturday\b/i, -2],
  [/\bsunday\b/i, -2],
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Days until the next occurrence of a named weekday, 1..7. */
export function daysUntilWeekday(name: string, from = new Date()): number {
  const target = WEEKDAYS.indexOf(name.toLowerCase());
  if (target < 0) return 1;
  const delta = (target - from.getDay() + 7) % 7;
  return delta === 0 ? 7 : delta;
}

function parseWhen(text: string): { dueInDays?: number; cleaned: string } {
  const inDays = /\bin (\d+) days?\b/i.exec(text);
  if (inDays?.[1]) {
    return { dueInDays: Number(inDays[1]), cleaned: text.replace(inDays[0], '').trim() };
  }
  for (const [re, days] of WHEN) {
    const m = re.exec(text);
    if (!m) continue;
    if (days === -1) continue;
    const cleaned = text.replace(m[0], '').trim();
    if (days === -2) {
      return { dueInDays: daysUntilWeekday(m[0].trim()), cleaned };
    }
    return { dueInDays: days, cleaned };
  }
  return { cleaned: text };
}

/**
 * Parse an input into a command, or return null.
 *
 * Returning null is the common and correct outcome: a bare account name is a
 * navigation, and a question is a question.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim();
  if (text.length < 3) return null;

  // A trailing question mark is always a question, never a command.
  if (text.endsWith('?')) return null;

  /* ── Log an interaction ─────────────────────────────────────────────────── */
  const logged =
    /^(?:log|note|jot)\s+(?:a\s+)?(?:call|meeting|chat|note|conversation)?\s*(?:with|on|for|re|about)?\s*(.*)$/i.exec(
      text,
    );
  if (logged) {
    const rest = (logged[1] ?? '').trim();
    return {
      kind: 'log_note',
      tool: 'add_note',
      label: 'Log note',
      rest,
      needsTarget: true,
      risk: 'medium',
      via: 'tool',
    };
  }

  /* ── Create a task ──────────────────────────────────────────────────────── */
  const task =
    /^(?:task|todo|to-do|remind me to|follow ?up|chase)\s*(?:with|on|for|to|about)?\s*(.*)$/i.exec(
      text,
    );
  if (task) {
    const raw = (task[1] ?? '').trim();
    const { dueInDays, cleaned } = parseWhen(raw);
    const looksFollowUp = /^follow ?up|^chase/i.test(text);
    return {
      kind: 'create_task',
      tool: 'create_task',
      label: 'New task',
      rest: cleaned || (looksFollowUp ? 'Follow up' : ''),
      ...(dueInDays != null ? { dueInDays } : {}),
      needsTarget: false,
      risk: 'medium',
      via: 'tool',
    };
  }

  /* ── Move a deal ────────────────────────────────────────────────────────── */
  const move = /^(?:move|advance|push|set)\s+(.*?)\s+(?:to|into|as)\s+(.+)$/i.exec(text);
  if (move) {
    const wanted = (move[2] ?? '').trim().toLowerCase();
    const stage = STAGES.find((s) => s.startsWith(wanted) || wanted.startsWith(s));
    if (stage) {
      return {
        kind: 'move_stage',
        tool: 'change_pipeline_stage',
        label: `Move to ${stage.replace(/\b\w/g, (c) => c.toUpperCase())}`,
        rest: (move[1] ?? '').trim(),
        stage,
        needsTarget: true,
        risk: 'medium',
        via: 'tool',
      };
    }
  }

  /* ── Draft an email ─────────────────────────────────────────────────────── */
  const draft = /^(?:draft|write|compose)\s+(?:an?\s+)?(?:follow ?up|email|reply|note)?\s*(?:to|for)?\s*(.*)$/i.exec(
    text,
  );
  if (draft) {
    return {
      kind: 'draft_email',
      tool: 'draft_email',
      label: 'Draft follow-up',
      rest: (draft[1] ?? '').trim(),
      needsTarget: true,
      // Drafting does not send; sending is separately HIGH risk.
      risk: 'medium',
      via: 'draft_endpoint',
    };
  }

  /* ── Create a record ────────────────────────────────────────────────────── */
  const newRecord = /^(?:new|add|create)\s+(account|company|contact|person)\s+(.+)$/i.exec(text);
  if (newRecord) {
    const what = (newRecord[1] ?? '').toLowerCase();
    const name = (newRecord[2] ?? '').trim();
    const isContact = what === 'contact' || what === 'person';
    return {
      kind: isContact ? 'create_contact' : 'create_account',
      tool: isContact ? 'create_contact' : 'create_account',
      label: isContact ? 'New contact' : 'New account',
      rest: name,
      newName: name,
      needsTarget: false,
      risk: 'medium',
      via: 'tool',
    };
  }

  return null;
}

/**
 * Build the tool payload once a target has been bound.
 *
 * Kept separate from parsing so the UI can show the row before a target is
 * chosen, and so the payload is assembled in exactly one place.
 */
export function buildPayload(
  command: ParsedCommand,
  target?: { type: string; id: string; name: string },
): Record<string, unknown> | null {
  const accountId = target?.type === 'account' ? target.id : undefined;
  const opportunityId = target?.type === 'opportunity' ? target.id : undefined;
  const contactId = target?.type === 'contact' ? target.id : undefined;

  switch (command.kind) {
    case 'log_note': {
      // add_note is keyed on an explicit subject, not just a foreign key.
      if (!target) return null;
      const body = command.rest || 'Logged from the command bar.';
      if (body.length < 3) return null;
      return {
        body,
        subjectType: target.type,
        subjectId: target.id,
        ...(accountId ? { accountId } : {}),
        ...(opportunityId ? { opportunityId } : {}),
      };
    }

    case 'create_task': {
      const title = command.rest || 'Follow up';
      // create_task enforces a 3-character floor.
      if (title.length < 3) return null;
      return {
        title,
        ...(command.dueInDays != null ? { dueInDays: command.dueInDays } : {}),
        ...(accountId ? { accountId } : {}),
        ...(opportunityId ? { opportunityId } : {}),
        ...(contactId ? { contactId } : {}),
      };
    }

    case 'move_stage': {
      if (!opportunityId) return null;
      return {
        opportunityId,
        stageName: titleCaseStage(command.stage ?? ''),
        // change_pipeline_stage requires a reason, and the honest one is that
        // a person asked for it — not an invented piece of evidence.
        reason: `Moved from the command bar by ${target?.name ?? 'the deal owner'}.`,
      };
    }

    case 'draft_email': {
      // Routed to /api/draft, whose shape is the three optional ids.
      if (!accountId && !contactId && !opportunityId) return null;
      return {
        ...(accountId ? { accountId } : {}),
        ...(contactId ? { contactId } : {}),
        ...(opportunityId ? { opportunityId } : {}),
        ...(command.rest ? { purpose: command.rest.slice(0, 200) } : {}),
      };
    }

    case 'create_account':
      return command.newName && command.newName.length >= 2 ? { name: command.newName } : null;

    case 'create_contact': {
      const parts = (command.newName ?? '').split(/\s+/).filter(Boolean);
      if (parts.length < 2) return null;
      return {
        firstName: parts[0]!,
        lastName: parts.slice(1).join(' '),
        ...(accountId ? { accountId } : {}),
      };
    }
  }
}

function titleCaseStage(stage: string): string {
  return stage.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Which capability a command exercises, for the learning loop. */
export function learningTaskFor(kind: CommandKind): LearningTask {
  return kind === 'draft_email' ? 'draft_email' : 'tool_choice';
}
