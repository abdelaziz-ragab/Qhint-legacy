import type { ModelCallType } from '@qhint/schema';
import type { PromptRequest } from '@qhint/prompts';

export type CallType = ModelCallType;
export type { ContentPart } from '@qhint/prompts';

/** What the gateway sends to a provider: a built prompt. */
export type ModelRequest = Pick<
  PromptRequest,
  'system' | 'content' | 'maxTokens' | 'outputSchema' | 'tools' | 'effort'
> &
  Partial<Pick<PromptRequest, 'promptId'>>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  /** e.g. end_turn, tool_use, max_tokens, refusal. */
  stopReason: string;
  usage: Usage;
}

/** One model backend (Anthropic API, Vertex, a customer-owned account, a fake for tests). */
export interface ModelProvider {
  readonly name: string;
  complete(model: string, req: ModelRequest): Promise<ProviderResponse>;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
