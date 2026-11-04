import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelRequest, ProviderResponse } from './types';

/** Anthropic API provider. The API key lives only in the backend (env / Secret Manager). */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string, opts: { timeoutMs?: number } = {}) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: opts.timeoutMs ?? 60_000 });
  }

  async complete(model: string, req: ModelRequest): Promise<ProviderResponse> {
    const content: Anthropic.Messages.ContentBlockParam[] = req.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mediaType,
              data: part.data.toString('base64'),
            },
          },
    );
    const res = await this.client.messages.create({
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content }],
      output_config: {
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.outputSchema
          ? { format: { type: 'json_schema' as const, schema: req.outputSchema } }
          : {}),
      },
      ...(req.tools ? { tools: req.tools as Anthropic.Messages.ToolUnion[] } : {}),
    });

    let text = '';
    const toolCalls: ProviderResponse['toolCalls'] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ name: block.name, input: block.input });
    }
    return {
      text,
      toolCalls,
      stopReason: res.stop_reason ?? 'unknown',
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
