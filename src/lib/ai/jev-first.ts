import { env } from '@/lib/env';
import { jevConfigured } from './jev';
import { routerEnabled } from './router';

/**
 * Jev first, an LLM only if needed.
 *
 * Jev is not an LLM. It never writes; it answers typed questions — pick one
 * option, place on a scale, how likely is this true — in about 0.3 seconds
 * for a fraction of a cent. So a job that is really a *decision* (classify
 * this question, does this need a reply) should go to Jev and stop there. An
 * LLM is only needed when the job is writing or reasoning, or when Jev is not
 * sure. That is the whole rule: Jev decides, the LLM writes, and when Jev is
 * unsure, the LLM makes the call.
 *
 * Model *choice* for the LLM jobs is router.ts. This file is the gate in front
 * of it: whether an LLM is needed at all.
 *
 * Privacy. A decision about content needs the content, and anything sent to
 * Jev leaves the building for TypeSafe. Three levels, each its own switch:
 *
 *   job_shape         a description of the job — never anyone's words.
 *                     What the model router sends. On with JEV_ROUTER.
 *   operator_text     the signed-in user's own words, e.g. an Ask Bolt
 *                     question. Needs JEV_SEND_CONTENT.
 *   customer_content  other people's words: emails, transcripts. Needs
 *                     JEV_CUSTOMER_CONTENT, separately, because it is the
 *                     customer's data, not the user's.
 */

export type JevContentClass = 'job_shape' | 'operator_text' | 'customer_content';

/** May Jev read this class of content? False means: use the LLM path. */
export function jevMayRead(content: JevContentClass): boolean {
  if (!routerEnabled() || !jevConfigured()) return false;
  switch (content) {
    case 'job_shape':
      return true;
    case 'operator_text':
      return env.JEV_SEND_CONTENT;
    case 'customer_content':
      return env.JEV_CUSTOMER_CONTENT;
  }
}

/** Who made a decision — shown to the user and written to the audit log. */
export type DecidedBy = 'jev' | 'llm' | 'default';
