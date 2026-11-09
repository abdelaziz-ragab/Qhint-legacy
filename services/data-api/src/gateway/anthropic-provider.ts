import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelRequest, ProviderResponse } from './types';

type Part = ModelRequest['content'][number];

/** Map a provider-neutral part to an Anthropic content block (with its cache marker). */
function toBlock(part: Part): Anthropic.Messages.ContentBlockParam {
  const cache = part.cache ? { cache_control: { type: 'ephemeral' as const } } : {};
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, ...cache };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.data.toString('base64') },
        ...cache,
      };
    case 'document':
      return {
        type: 'document',
        source:
          part.mediaType === 'application/pdf'
            ? { type: 'base64', media_type: 'application/pdf', data: part.data.toString('base64') }
            : { type: 'text', media_type: 'text/plain', data: part.data.toString('utf8') },
        ...(part.title ? { title: part.title } : {}),
        ...cache,
      };
  }
}

/** Anthropic API provider. The API key lives only in the backend (env / Secret Manager). */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string, opts: { timeoutMs?: number } = {}) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: opts.timeoutMs ?? 60_000 });
  }

  async complete(model: string, req: ModelRequest): Promise<ProviderResponse> {
    const content = req.content.map(toBlock);
    const res = await this.client.messages.create(
      {
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
      },
      req.timeoutMs ? { timeout: req.timeoutMs } : undefined,
    );

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
