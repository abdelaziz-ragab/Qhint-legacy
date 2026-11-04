import type { LocateResult, Step } from '@qhint/schema';
import { describe, expect, it, vi } from 'vitest';
import type { DisplayCapture } from '../capture/capture';
import { GroundingEngine, type GroundingProvider, ModelGroundingProvider } from './grounding';

const step: Step = {
  id: 's1',
  instruction: 'Click Insert',
  app: { name: 'LibreOffice Writer', kind: 'native' },
  action: 'click',
  target: { description: 'Insert button', neighbors: [] },
  optional: false,
};
const capture = {
  label: 'screen_1',
  image: { width: 1280, height: 720 },
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
} as unknown as DisplayCapture;
const found: LocateResult = {
  kind: 'found',
  screen: 'screen_1',
  bbox: [1, 1, 9, 9],
  confidence: 'high',
  label: 'x',
};

const provider = (name: 'cache' | 'model', answer: LocateResult | null): GroundingProvider => ({
  name,
  locate: vi.fn(async () => answer),
});

describe('GroundingEngine', () => {
  it('uses the cache first and skips the model when the cache answers', async () => {
    const cache = provider('cache', found);
    const model = provider('model', found);
    const r = await new GroundingEngine([cache, model]).locate(step, [capture], {
      escalate: false,
    });
    expect(r.source).toBe('cache');
    expect(model.locate).not.toHaveBeenCalled();
  });

  it('falls through to the model on a cache miss', async () => {
    const engine = new GroundingEngine([provider('cache', null), provider('model', found)]);
    const r = await engine.locate(step, [capture], { escalate: false });
    expect(r.source).toBe('model');
  });

  it('answers none when nothing could be captured', async () => {
    const r = await new GroundingEngine([provider('model', found)]).locate(step, [], {
      escalate: false,
    });
    expect(r.result.kind).toBe('none');
  });
});

describe('ModelGroundingProvider', () => {
  it('sends labelled screenshots and the step, and passes escalate through', async () => {
    const post = vi.fn(
      async () => new Response(JSON.stringify({ result: found }), { status: 200 }),
    );
    const r = await new ModelGroundingProvider(post).locate(step, [capture], { escalate: true });
    expect(r).toEqual(found);
    const [path, body] = post.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe('/locate');
    expect(body).toMatchObject({
      escalate: true,
      appCategory: 'native',
      screens: [{ label: 'screen_1', width: 1280, height: 720 }],
    });
  });

  it('throws on HTTP errors so the runner can show text-only guidance', async () => {
    const post = vi.fn(async () => new Response('{}', { status: 502 }));
    await expect(
      new ModelGroundingProvider(post).locate(step, [capture], { escalate: false }),
    ).rejects.toThrow('locate_502');
  });
});
