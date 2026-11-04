import type { ModelProvider, ModelRequest, ProviderResponse } from './types';

/** Deterministic stand-in for development and tests (no network, no cost). */
export class FakeModelProvider implements ModelProvider {
  readonly name = 'fake';
  readonly calls: { model: string; request: ModelRequest }[] = [];

  constructor(private readonly respond: (model: string, req: ModelRequest) => string | Error) {}

  async complete(model: string, request: ModelRequest): Promise<ProviderResponse> {
    this.calls.push({ model, request });
    const out = this.respond(model, request);
    if (out instanceof Error) throw out;
    const inputTokens = Math.ceil(request.system.length / 4) + request.content.length * 100;
    return {
      text: out,
      usage: {
        inputTokens,
        outputTokens: Math.ceil(out.length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}
