/**
 * The model gateway: the only path from Qhint to any AI model. It picks the model per call type,
 * hands the raw response to the caller's interpreter (strict JSON validated with zod, or a
 * tool-call reader), and records content-free metrics (model, tokens, cost, latency, outcome)
 * for every call. Prompts and outputs are never logged.
 */
import type { OperatorEvent } from '@qhint/schema';
import { hashId } from '@qhint/server-kit';
import type { z } from 'zod';
import type {
  CallType,
  ModelPrice,
  ModelProvider,
  ModelRequest,
  ProviderResponse,
  Usage,
} from './types';

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

/** Thrown by an interpreter when the model's answer is unusable (counted as invalid_output). */
export class InvalidOutput extends Error {
  constructor() {
    super('invalid_output');
  }
}

export type Interpreter<T> = (response: ProviderResponse) => T;

export type GatewayFailure = 'invalid_output' | 'provider_error' | 'refusal';

export type GatewayResult<T> =
  | { ok: true; value: T; model: string; usage: Usage; latencyMs: number }
  | { ok: false; code: GatewayFailure; model: string; latencyMs: number };

export type EventEmitter = (event: OperatorEvent) => void;

export function costMicroUsd(usage: Usage, price: ModelPrice | undefined): number {
  if (!price) return 0;
  // price is USD per 1M tokens, so micro-USD per token is exactly `price`.
  return Math.round(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite,
  );
}

/** Strict JSON: the whole response must be one JSON value (optionally inside a ```json fence). */
export function parseStrictJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

/** Interpreter for prompts that answer with JSON validated by a zod schema. */
export function strictJson<S extends z.ZodType>(schema: S): Interpreter<z.infer<S>> {
  return (response) => {
    let value: unknown;
    try {
      value = parseStrictJson(response.text);
    } catch {
      throw new InvalidOutput();
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new InvalidOutput();
    return parsed.data;
  };
}

export class ModelGateway {
  constructor(
    private readonly provider: ModelProvider,
    private readonly config: GatewayConfig,
    private readonly emit: EventEmitter,
  ) {}

  modelFor(callType: CallType, tier: 'primary' | 'escalation'): string {
    const choice = this.config.models[callType];
    return tier === 'escalation' && choice.escalation ? choice.escalation : choice.primary;
  }

  async call<T>(
    callType: CallType,
    caller: CallerContext,
    request: ModelRequest,
    interpret: Interpreter<T>,
    tier: 'primary' | 'escalation' = 'primary',
  ): Promise<GatewayResult<T>> {
    const model = this.modelFor(callType, tier);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    let usage: Usage | undefined;
    let result: GatewayResult<T>;
    try {
      const response = await this.provider.complete(model, request);
      usage = response.usage;
      if (response.stopReason === 'refusal') {
        result = { ok: false, code: 'refusal', model, latencyMs: elapsed() };
      } else {
        try {
          result = { ok: true, value: interpret(response), model, usage, latencyMs: elapsed() };
        } catch {
          result = { ok: false, code: 'invalid_output', model, latencyMs: elapsed() };
        }
      }
    } catch {
      result = { ok: false, code: 'provider_error', model, latencyMs: elapsed() };
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
