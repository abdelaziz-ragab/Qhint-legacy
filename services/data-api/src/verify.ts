import { buildVerifyV1, interpretVerifyV1, type VerifyInput } from '@qhint/prompts';
import type { VerifyResult } from '@qhint/schema';
import {
  type CallerContext,
  InvalidOutput,
  type ModelGateway,
  parseStrictJson,
} from './gateway/gateway';

export interface VerifyOutcome {
  result: VerifyResult;
  model: string;
  latencyMs: number;
}

/** Did the user complete the step? Failures count as "not_done": we never assume success. */
export async function verify(
  gateway: ModelGateway,
  caller: CallerContext,
  input: VerifyInput,
): Promise<VerifyOutcome> {
  const r = await gateway.call('verify', caller, buildVerifyV1(input), (res) => {
    try {
      return interpretVerifyV1(parseStrictJson(res.text));
    } catch {
      throw new InvalidOutput();
    }
  });
  return {
    result: r.ok ? r.value : { status: 'not_done', explanation: '' },
    model: r.model,
    latencyMs: r.latencyMs,
  };
}
