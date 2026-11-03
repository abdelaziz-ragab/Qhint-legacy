import { describe, expect, it } from 'vitest';
import { LEAK_SCORE_LIMIT, ringLeakScore, type Bitmap } from './leak-check';

function solid(width: number, height: number, v: number): Bitmap {
  const pixels = new Uint8Array(width * height * 4).fill(v);
  return { width, height, pixels };
}

function drawRect(b: Bitmap, x1: number, y1: number, x2: number, y2: number, v: number) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      if (x === x1 || x === x2 || y === y1 || y === y2) {
        const i = (y * b.width + x) * 4;
        b.pixels[i] = v;
        b.pixels[i + 1] = v;
        b.pixels[i + 2] = v;
      }
    }
  }
}

describe('ringLeakScore', () => {
  const ring = { x: 10, y: 10, width: 40, height: 20 };

  it('is 0 when nothing changed', () => {
    expect(ringLeakScore(solid(64, 64, 30), solid(64, 64, 30), [ring])).toBe(0);
  });

  it('is high when the ring is visible in the second capture', () => {
    const after = solid(64, 64, 30);
    drawRect(after, 10, 10, 49, 29, 250);
    expect(ringLeakScore(solid(64, 64, 30), after, [ring])).toBeGreaterThan(LEAK_SCORE_LIMIT);
  });

  it('ignores changes away from the ring (e.g. a clock ticking)', () => {
    const after = solid(64, 64, 30);
    drawRect(after, 55, 55, 63, 63, 250);
    expect(ringLeakScore(solid(64, 64, 30), after, [ring])).toBe(0);
  });

  it('skips points outside the image', () => {
    const offscreen = { x: -10, y: -10, width: 200, height: 200 };
    expect(ringLeakScore(solid(16, 16, 0), solid(16, 16, 0), [offscreen])).toBe(0);
  });

  it('rejects mismatched sizes', () => {
    expect(() => ringLeakScore(solid(8, 8, 0), solid(9, 8, 0), [ring])).toThrow();
  });
});
