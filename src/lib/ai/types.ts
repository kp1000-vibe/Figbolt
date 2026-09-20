import type { SourceRef } from '@/db/schema';

/**
 * Provider-agnostic model interface.
 *
 * Deliberately small: text in, text or tool calls out, plus a structured
 * variant. Everything product-specific (retrieval, citation, permissions) lives
 * above this line so swapping Anthropic for OpenAI touches one adapter file.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ModelMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/** JSON Schema subset every provider's tool-calling API accepts. */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type JsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  format?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type CompletionRequest = {
  system: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  temperature?: number;
  /**
   * Hint used only by the offline engine to select a deterministic strategy.
   * Hosted providers ignore it — the schema and prompt carry the intent.
   */
  task?: TaskKind;
  /** Retrieved evidence. Always rendered inside untrusted-content fences. */
  evidence?: EvidenceItem[];
};

export type CompletionResult = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
  usage: TokenUsage;
  model: string;
};

export type TokenUsage = { promptTokens: number; completionTokens: number };

export type StructuredRequest<T> = {
  system: string;
  instruction: string;
  schema: JsonSchema;
  task: TaskKind;
  evidence?: EvidenceItem[];
  /** Trusted workspace configuration (company context, playbooks). */
  workspaceContext?: string;
  maxTokens?: number;
  temperature?: number;
  /** Runtime validator; a provider result failing it triggers one repair pass. */
  validate?: (value: unknown) => value is T;
};

export type StructuredResult<T> = {
  value: T;
  usage: TokenUsage;
  model: string;
  /** How much of the answer the model considers supported by the evidence. */
  confidence: number;
};

export const TASK_KINDS = [
  'answer_question',
  'summarize_account',
  'summarize_opportunity',
  'summarize_contact',
  'summarize_meeting',
  'extract_facts',
  'extract_commitments',
  'extract_objections',
  'extract_product_signals',
  'score_deal_health',
  'draft_email',
  'plan_agent',
  'compile_agent',
  'classify_intent',
  'analytics_query',
  'suggest_stage',
  'build_icp',
  'daily_briefing',
  'generate_insights',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * A retrieved piece of context.
 *
 * `trust` is the security-relevant field: `untrusted` content (customer emails,
 * uploaded documents, transcripts) is fenced and explicitly labelled in the
 * prompt, and the runtime never lets instructions inside it reach tool
 * dispatch. See `src/lib/ai/prompt.ts`.
 */
export type EvidenceItem = {
  ref: SourceRef;
  content: string;
  trust: 'trusted' | 'untrusted';
  /** Combined hybrid-retrieval score, used for ordering and truncation. */
  score?: number;
  metadata?: Record<string, unknown>;
};

/** The envelope every user-visible AI answer is wrapped in. */
export type AnswerEnvelope = {
  answer: string;
  confidence: number;
  /** Empty means the model found no support — the UI says so explicitly. */
  sources: SourceRef[];
  recommendedActions: {
    title: string;
    why: string;
    action?: { kind: string; payload?: Record<string, unknown> };
  }[];
  extractedEntities: { type: string; id?: string; label: string }[];
  /** Short public recap of method. Never private chain-of-thought. */
  reasoningSummary: string;
  /** Set when evidence was thin, so the UI can caveat the answer. */
  caveat?: string;
};

export interface LanguageModel {
  readonly id: string;
  readonly provider: 'anthropic' | 'openai' | 'google' | 'local';
  /** True when calls leave this machine — gates PII redaction. */
  readonly isRemote: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
