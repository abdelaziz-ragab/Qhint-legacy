import type { ModelProvider, ModelRequest, ProviderResponse } from './types';

type FakeReply =
  string | Error | (Pick<ProviderResponse, 'text' | 'toolCalls'> & { stopReason?: string });

/** Deterministic stand-in for development and tests (no network, no cost). */
export class FakeModelProvider implements ModelProvider {
  readonly name = 'fake';
  readonly calls: { model: string; request: ModelRequest }[] = [];

  constructor(private readonly respond: (model: string, req: ModelRequest) => FakeReply) {}

  async complete(model: string, request: ModelRequest): Promise<ProviderResponse> {
    this.calls.push({ model, request });
    const out = this.respond(model, request);
    if (out instanceof Error) throw out;
    const reply = typeof out === 'string' ? { text: out, toolCalls: [] } : out;
    const inputTokens = Math.ceil(request.system.length / 4) + request.content.length * 100;
    return {
      text: reply.text,
      toolCalls: reply.toolCalls,
      stopReason: ('stopReason' in reply && reply.stopReason) || 'end_turn',
      usage: {
        inputTokens,
        outputTokens: Math.ceil(reply.text.length / 4) + 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}
