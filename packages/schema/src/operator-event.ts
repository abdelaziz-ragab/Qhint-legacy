/**
 * Operator analytics events. Content-free by construction:
 * - strict objects: unknown fields are rejected, not stripped
 * - every string is an enum or a tightly constrained code; no free text anywhere
 * - tenant/user identifiers are HMAC hashes, never raw ids
 */
import { z } from 'zod';
import { AppKind, Timestamp } from './common';

const Hmac = z.string().regex(/^[a-f0-9]{64}$/, 'must be a hex HMAC-SHA256');
const Code = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'must be a snake_case code');
const Count = z.int().min(0);

export const ModelCallType = z.enum(['ingest', 'assess', 'locate', 'verify', 'live']);
export type ModelCallType = z.infer<typeof ModelCallType>;

export const AppCategory = z.enum([...AppKind.options, 'unknown']);
export type AppCategory = z.infer<typeof AppCategory>;

export const OperatorEventType = z.enum([
  'model_call',
  'run_started',
  'run_finished',
  'step_finished',
  'ingest_finished',
  'search',
  'gap_logged',
]);
export type OperatorEventType = z.infer<typeof OperatorEventType>;

export const OperatorEvent = z.strictObject({
  type: OperatorEventType,
  ts: Timestamp,
  tenantHash: Hmac,
  userHash: Hmac.optional(),

  // model calls
  callType: ModelCallType.optional(),
  model: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.@-]{0,63}$/)
    .optional(),
  inputTokens: Count.optional(),
  outputTokens: Count.optional(),
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
  costMicroUsd: Count.optional(),
  latencyMs: Count.optional(),
  cacheHit: z.boolean().optional(),

  // outcomes
  outcome: Code.optional(),
  failureCode: Code.optional(),

  // generic measures
  count: Count.optional(),
  durationMs: Count.optional(),
  appCategory: AppCategory.optional(),
});
export type OperatorEvent = z.infer<typeof OperatorEvent>;
