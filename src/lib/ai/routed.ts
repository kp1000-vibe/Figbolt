import { routeTask, type RoutableModel, type RouteRequest, type RoutingDecision } from './router';
import {
  ModelError,
  type CompletionRequest,
  type CompletionResult,
  type LanguageModel,
  type RoutingSummary,
  type StructuredRequest,
  type StructuredResult,
} from './types';

/**
 * A model that asks Jev, on every call, which real model should answer.
 *
 * This is what puts Jev in control of the whole product rather than of one
 * feature: getLanguageModel() returns it whenever routing is on, so every AI
 * call site — Ask Bolt, summaries, extraction, drafting, agents — is routed
 * without having to remember to opt in.
 *
 * Failover: if the model Jev picked errors (a provider outage, a rejected
 * request), the call is retried once on the default model. Jev's choice is a
 * cost and quality decision; it should never be the reason a question goes
 * unanswered.
 */
export class JevRoutedModel implements LanguageModel {
  readonly id: string;
  readonly provider: LanguageModel['provider'];
  /** Remote if anything it might route to is remote — this gates PII redaction. */
  readonly isRemote: boolean;

  constructor(
    private readonly candidates: readonly RoutableModel[],
    private readonly fallback: LanguageModel,
    private readonly route: typeof routeTask = routeTask,
  ) {
    this.id = `jev-routed(${fallback.id})`;
    this.provider = fallback.provider;
    this.isRemote = fallback.isRemote || candidates.some((c) => c.model.isRemote);
  }

  /** The decision for one request; exposed so a multi-step caller can pin it. */
  decide(request: RouteRequest): Promise<RoutingDecision> {
    return this.route(request, this.candidates, this.fallback);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const decision = await this.decide({
      task: request.task,
      evidence: request.evidence,
      usesTools: Boolean(request.tools?.length),
      expectsProse: !request.tools?.length,
    });
    return this.run(decision, (m) => m.complete(request));
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const decision = await this.decide({
      task: request.task,
      evidence: request.evidence,
      expectsProse: request.task === 'answer_question' || request.task === 'draft_email',
    });
    return this.run(decision, (m) => m.completeStructured(request));
  }

  private async run<R extends { model: string; routing?: RoutingSummary }>(
    decision: RoutingDecision,
    call: (model: LanguageModel) => Promise<R>,
  ): Promise<R> {
    const summary: RoutingSummary = {
      decidedBy: decision.reason === 'jev' ? 'jev' : 'default',
      reason: decision.reason,
      confidence: decision.confidence,
    };

    try {
      const result = await call(decision.model);
      return { ...result, routing: summary };
    } catch (err) {
      const canFailOver = decision.model !== this.fallback && err instanceof ModelError;
      if (!canFailOver) throw err;

      console.warn(
        `[ai] ${decision.model.id} (chosen by Jev) failed: ${(err as Error).message.slice(0, 160)} — ` +
          `retrying on ${this.fallback.id}`,
      );
      const result = await call(this.fallback);
      return { ...result, routing: { ...summary, failedOverFrom: decision.model.id } };
    }
  }
}
