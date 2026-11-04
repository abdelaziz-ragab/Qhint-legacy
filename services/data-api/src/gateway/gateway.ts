/**
 * The model gateway: the only path from Qhint to any AI model. It picks the model per call type,
 * enforces strict JSON output validated with zod, and records content-free metrics (model,
 * tokens, cost, latency, outcome code) for every call. Prompts and outputs are never logged.
 */
import type { OperatorEvent } from '@qhint/schema';
import { hashId } from '@qhint/server-kit';
import type { z } from 'zod';
import type { CallType, ModelPrice, ModelProvider, ModelRequest, Usage } from './types';

export interface GatewayConfig {
  /** Model per call type; `escalation` is used when the caller asks for the stronger tier. */
  models: Record<CallType, { primary: string; escalation?: string }>;
  prices: Record<string, ModelPrice>;
  /** HMAC key for hashing tenant/user ids in analytics. */
  analyticsKey: string;
}

export interface CallerContext {
  tenantId: string;
  userId: string;
  appCategory?: OperatorEvent['appCategory'];
}

export type GatewayResult<T> =
  | { ok: true; value: T; model: string; usage: Usage; latencyMs: number }
  | { ok: false; code: 'invalid_output' | 'provider_error'; model: string; latencyMs: number };

export type EventEmitter = (event: OperatorEvent) => void;

export function costMicroUsd(usage: Usage, price: ModelPrice | undefined): number {
  if (!price) return 0;
  const perToken =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite;
  // price is USD per 1M tokens => micro-USD per token is exactly `price`.
  return Math.round(perToken);
}

/** Strict JSON: the whole response must be one JSON value (optionally inside a ```json fence). */
export function parseStrictJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

export class ModelGateway {
  constructor(
    private readonly provider: ModelProvider,
    private readonly config: GatewayConfig,
    private readonly emit: EventEmitter,
  ) {}

  async call<S extends z.ZodType>(
    callType: CallType,
    caller: CallerContext,
    request: ModelRequest,
    schema: S,
    tier: 'primary' | 'escalation' = 'primary',
  ): Promise<GatewayResult<z.infer<S>>> {
    const choice = this.config.models[callType];
    const model = tier === 'escalation' && choice.escalation ? choice.escalation : choice.primary;
    const started = performance.now();

    let usage: Usage | undefined;
    let result: GatewayResult<z.infer<S>>;
    try {
      const res = await this.provider.complete(model, request);
      usage = res.usage;
      const latencyMs = Math.round(performance.now() - started);
      let parsed: z.ZodSafeParseResult<z.infer<S>> | null = null;
      try {
        parsed = schema.safeParse(parseStrictJson(res.text));
      } catch {
        parsed = null;
      }
      result = parsed?.success
        ? { ok: true, value: parsed.data, model, usage: res.usage, latencyMs }
        : { ok: false, code: 'invalid_output', model, latencyMs };
    } catch {
      result = {
        ok: false,
        code: 'provider_error',
        model,
        latencyMs: Math.round(performance.now() - started),
      };
    }

    this.emit({
      type: 'model_call',
      ts: new Date().toISOString(),
      tenantHash: hashId(this.config.analyticsKey, caller.tenantId),
      userHash: hashId(this.config.analyticsKey, caller.userId),
      callType,
      model,
      latencyMs: result.latencyMs,
      outcome: result.ok ? 'ok' : result.code,
      ...(usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costMicroUsd: costMicroUsd(usage, this.config.prices[model]),
            cacheHit: usage.cacheReadTokens > 0,
          }
        : {}),
      ...(caller.appCategory ? { appCategory: caller.appCategory } : {}),
    });
    return result;
  }
}
