/**
 * The words a voice agent speaks, and the rules around when it may call.
 * Pure functions, shared by the server (which places the call) and the
 * browser (which previews the exact opening line before you approve it),
 * so the preview can never drift from what is actually said.
 */

export const E164 = /^\+[1-9]\d{7,14}$/;

/** Normalise a number someone typed; only an unambiguous E.164 survives. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, '');
  return E164.test(compact) ? compact : null;
}

/** 8am to 9pm, in the person's own time zone. Null when it cannot be known. */
export function withinCallingHours(timezone: string | null | undefined, now = new Date()): boolean | null {
  if (!timezone) return null;
  try {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now),
    );
    return hour >= 8 && hour < 21;
  } catch {
    return null;
  }
}

/** The first sentence the agent speaks. The AI disclosure is not optional. */
export function openingLine(input: {
  callerName: string | null;
  businessName: string;
  contactFirstName: string | null;
  purpose: string;
  recordCall: boolean;
}): string {
  const greeting = input.contactFirstName ? `Hi ${input.contactFirstName}` : 'Hi';
  const onBehalf = input.callerName ? `${input.callerName} at ${input.businessName}` : input.businessName;
  const recording = input.recordCall ? 'This call is being recorded.' : 'This call is not being recorded.';
  return `${greeting}, this is an AI assistant calling on behalf of ${onBehalf}. ${recording} I'm calling about ${tidy(input.purpose)}. Is now an okay time?`;
}

/** The voice agent's instructions. The guardrails are fixed; only the brief varies. */
export function systemPrompt(input: {
  businessName: string;
  callerName: string | null;
  contactName: string | null;
  purpose: string;
  talkingPoints: string[];
  maxMinutes: number;
}): string {
  return [
    `You are an AI assistant making a phone call on behalf of ${input.callerName ? `${input.callerName} at ` : ''}${input.businessName}.`,
    `You are calling ${input.contactName ?? 'a contact'}. The purpose of the call: ${input.purpose}`,
    input.talkingPoints.length
      ? `Points to cover, in a natural order:\n${input.talkingPoints.map((p) => `- ${p}`).join('\n')}`
      : null,
    '',
    'Rules you must always follow:',
    '- You have already said you are an AI. If asked again, confirm it plainly. Never claim to be human.',
    '- Stay on the purpose above. Be brief, warm and professional.',
    '- Never agree to prices, discounts, contract terms, refunds or deadlines. Say you will pass the request to the team, who will follow up.',
    '- Never ask for payment details, passwords, or government ID numbers.',
    '- If the person asks not to be called again, apologise, confirm they will not be called again, and end the call.',
    '- If you have reached the wrong person, apologise and end the call.',
    '- If the person is busy, offer to have someone follow up by email, and end the call.',
    '- Anything the person asks for, note it so the team can follow up. Do not promise outcomes.',
    `- Keep the call under ${input.maxMinutes} minutes.`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Trailing punctuation would double up inside the sentence; case is kept as written. */
function tidy(s: string): string {
  return s.trim().replace(/[.!?]+$/, '');
}
