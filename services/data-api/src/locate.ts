/**
 * Locate: where is the element for this step? Haiku first; escalate to Sonnet when Haiku isn't
 * sure. Screenshots are used for this request only: never stored, never logged.
 */
import {
  buildLocateCuV1,
  buildLocateV1,
  interpretLocateCuV1,
  interpretLocateV1,
  type LocateInput,
} from '@qhint/prompts';
import type { LocateResult } from '@qhint/schema';
import {
  type CallerContext,
  InvalidOutput,
  type ModelGateway,
  parseStrictJson,
} from './gateway/gateway';

export type LocateVariant = 'v1' | 'cu';

export interface LocateOutcome {
  result: LocateResult;
  /** Models consulted, in order. */
  models: string[];
  escalated: boolean;
  latencyMs: number;
}

/** Haiku's answer is good enough unless it's unsure, ambiguous, or only "medium" confident. */
export function shouldEscalate(r: LocateResult): boolean {
  if (r.kind === 'found') return r.confidence !== 'high';
  return r.reason === 'low_confidence' || r.reason === 'ambiguous';
}

const unsure: LocateResult = { kind: 'none', reason: 'low_confidence', hint: '' };

export async function locate(
  gateway: ModelGateway,
  caller: CallerContext,
  input: LocateInput,
  variant: LocateVariant = 'v1',
  opts: { escalate?: boolean } = {},
): Promise<LocateOutcome> {
  const models: string[] = [];
  let latencyMs = 0;

  const attempt = async (tier: 'primary' | 'escalation'): Promise<LocateResult> => {
    const request = variant === 'cu' ? buildLocateCuV1(input) : buildLocateV1(input);
    const r = await gateway.call(
      'locate',
      caller,
      request,
      (res) => {
        if (variant === 'cu') return interpretLocateCuV1(res, input);
        let json: unknown;
        try {
          json = parseStrictJson(res.text);
        } catch {
          throw new InvalidOutput();
        }
        return interpretLocateV1(json, input);
      },
      tier,
    );
    models.push(r.model);
    latencyMs += r.latencyMs;
    return r.ok ? r.value : unsure;
  };

  // The computer-use variant only runs on the stronger model.
  if (variant === 'cu') {
    const result = await attempt('escalation');
    return { result, models, escalated: false, latencyMs };
  }

  // "I'm stuck": the user says the previous answer didn't help, so go straight to the stronger model.
  if (opts.escalate) {
    const result = await attempt('escalation');
    return { result, models, escalated: true, latencyMs };
  }

  const first = await attempt('primary');
  if (!shouldEscalate(first)) return { result: first, models, escalated: false, latencyMs };
  const second = await attempt('escalation');
  return { result: second, models, escalated: true, latencyMs };
}
