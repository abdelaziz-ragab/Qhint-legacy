/**
 * Detects whether our own overlay leaked into a capture: compares pixels along the edges of the
 * drawn rings between a capture taken before drawing and one taken while the rings are shown.
 * Pure; works on raw 4-byte-per-pixel bitmaps of identical size.
 */
import type { Rect, Size } from '../../shared/geometry';

export interface Bitmap extends Size {
  pixels: Uint8Array;
}

const DIFF_THRESHOLD = 60; // summed abs RGB difference that counts as "changed"

function* edgePoints(r: Rect, image: Size, step: number): Generator<[number, number]> {
  const x1 = Math.round(r.x);
  const y1 = Math.round(r.y);
  const x2 = Math.round(r.x + r.width) - 1;
  const y2 = Math.round(r.y + r.height) - 1;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < image.width && y < image.height;
  for (let x = x1; x <= x2; x += step) {
    if (inside(x, y1)) yield [x, y1];
    if (inside(x, y2)) yield [x, y2];
  }
  for (let y = y1; y <= y2; y += step) {
    if (inside(x1, y)) yield [x1, y];
    if (inside(x2, y)) yield [x2, y];
  }
}

/**
 * Fraction (0..1) of sampled ring-edge pixels that changed. `rings` are in image pixels and
 * should describe where the ring stroke is drawn. ~0 means clean; high means the ring is visible.
 */
export function ringLeakScore(before: Bitmap, after: Bitmap, rings: Rect[], step = 2): number {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('bitmaps must be the same size');
  }
  let sampled = 0;
  let changed = 0;
  for (const ring of rings) {
    for (const [x, y] of edgePoints(ring, before, step)) {
      const i = (y * before.width + x) * 4;
      const diff =
        Math.abs(before.pixels[i]! - after.pixels[i]!) +
        Math.abs(before.pixels[i + 1]! - after.pixels[i + 1]!) +
        Math.abs(before.pixels[i + 2]! - after.pixels[i + 2]!);
      sampled++;
      if (diff > DIFF_THRESHOLD) changed++;
    }
  }
  return sampled === 0 ? 0 : changed / sampled;
}

export const LEAK_SCORE_LIMIT = 0.3;
