import { describe, expect, it } from 'vitest';
import { frameDiff, selectKeyframes } from './keyframes';

const SIZE = 64;
const screen = (v: number, patch = 0) => {
  const a = new Uint8Array(SIZE).fill(v);
  for (let i = 0; i < patch; i++) a[i] = v + 20; // a small local change, like a typed letter
  return a;
};
/** n frames of the same screen. */
const hold = (s: Uint8Array, n: number) => Array.from({ length: n }, () => s);

describe('frameDiff', () => {
  it('is 0 for equal frames and the mean absolute difference otherwise', () => {
    expect(frameDiff(screen(10), screen(10))).toBe(0);
    expect(frameDiff(screen(10), screen(20))).toBe(10);
  });
});

describe('selectKeyframes', () => {
  const fps = 4;

  it('keeps the first frame, the frame before each change, and the final state', () => {
    // 2 s of A, 2 s of B, 2 s of C.
    const thumbs = [...hold(screen(0), 8), ...hold(screen(100), 8), ...hold(screen(200), 8)];
    // (the first frame shows the same screen as 1.75, so only the later one is kept)
    expect(selectKeyframes(thumbs, { fps })).toEqual([1.75, 3.75, 5.75]);
  });

  it('treats an animation (several quick changes) as one transition', () => {
    const anim = [screen(20), screen(40), screen(60), screen(80)];
    const thumbs = [...hold(screen(0), 8), ...anim, ...hold(screen(100), 8)];
    // before the animation, and the end state; no frames from inside the animation
    expect(selectKeyframes(thumbs, { fps })).toEqual([1.75, 4.75]);
  });

  it('samples slow changes (typing) at the floor rate', () => {
    // Each frame differs a little (below the change threshold) from the previous one.
    const thumbs = Array.from({ length: 40 }, (_, k) => screen(0, Math.floor(k / 2)));
    const times = selectKeyframes(thumbs, { fps, floorSeconds: 3 });
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.length).toBeLessThanOrEqual(5);
    expect(times.at(-1)).toBe(9.75);
    // spaced out, not every frame
    for (let k = 1; k < times.length; k++)
      expect(times[k]! - times[k - 1]!).toBeGreaterThanOrEqual(0.75);
  });

  it('reduces a screen that never changes to a single frame', () => {
    expect(selectKeyframes(hold(screen(50), 40), { fps })).toEqual([9.75]);
  });

  it('respects the frame budget, keeping the biggest changes', () => {
    const thumbs: Uint8Array[] = [];
    for (let k = 0; k < 30; k++) thumbs.push(...hold(screen((k * 37) % 250), 6));
    const times = selectKeyframes(thumbs, { fps, maxFrames: 10 });
    expect(times.length).toBe(10);
    expect(times.at(-1)).toBe((thumbs.length - 1) / fps);
  });

  it('handles empty input', () => {
    expect(selectKeyframes([], { fps })).toEqual([]);
  });
});
