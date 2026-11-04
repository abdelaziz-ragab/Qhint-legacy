import type { ModelCallType } from '@qhint/schema';

export type CallType = ModelCallType;

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: Buffer; label?: string };

export interface ModelRequest {
  system: string;
  content: ContentPart[];
  maxTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResponse {
  text: string;
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
