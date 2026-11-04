/**
 * Grounding: find the target for a step. Providers are tried in order; the first answer wins.
 * Phase 3: element cache (stub, filled in Phase 5) -> vision model via data-api.
 */
import type { LocateResult, Step } from '@qhint/schema';
import type { DisplayCapture } from '../capture/capture';

export interface GroundingProvider {
  readonly name: 'cache' | 'model';
  /** null = "I have no answer, ask the next provider". */
  locate(
    step: Step,
    captures: DisplayCapture[],
    opts: { escalate: boolean },
  ): Promise<LocateResult | null>;
}

export interface GroundingAttempt {
  result: LocateResult;
  captures: DisplayCapture[];
  source: GroundingProvider['name'] | 'elements' | 'none';
}

export class ElementCacheProvider implements GroundingProvider {
  readonly name = 'cache' as const;
  async locate(): Promise<LocateResult | null> {
    return null; // Phase 5: template match against crops saved after successful steps.
  }
}

type Post = (path: string, body: unknown) => Promise<Response>;

/** Asks data-api /locate. Screenshots are sent for this request only and never stored. */
export class ModelGroundingProvider implements GroundingProvider {
  readonly name = 'model' as const;
  constructor(private readonly post: Post) {}

  async locate(
    step: Step,
    captures: DisplayCapture[],
    opts: { escalate: boolean },
  ): Promise<LocateResult | null> {
    const res = await this.post('/locate', {
      escalate: opts.escalate,
      appCategory: step.app.kind,
      step,
      screens: captures.map((c) => ({
        label: c.label,
        width: c.image.width,
        height: c.image.height,
        jpeg: c.jpeg.toString('base64'),
      })),
    });
    if (!res.ok) throw new Error(`locate_${res.status}`);
    const body = (await res.json()) as { result: LocateResult };
    return body.result;
  }
}

export class GroundingEngine {
  constructor(private readonly providers: GroundingProvider[]) {}

  /** Locate on screenshots the caller already took (so they can be reused, e.g. for checks). */
  async locate(
    step: Step,
    captures: DisplayCapture[],
    opts: { escalate: boolean },
  ): Promise<GroundingAttempt> {
    if (captures.length === 0) {
      return {
        result: { kind: 'none', reason: 'not_visible', hint: 'Screen capture is unavailable' },
        captures,
        source: 'none',
      };
    }
    for (const provider of this.providers) {
      const result = await provider.locate(step, captures, opts);
      if (result) return { result, captures, source: provider.name };
    }
    return {
      result: { kind: 'none', reason: 'low_confidence', hint: '' },
      captures,
      source: 'none',
    };
  }
}
