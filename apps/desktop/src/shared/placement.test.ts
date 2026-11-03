import { describe, expect, it } from 'vitest';
import { containsRect, intersectionArea, type Rect } from './geometry';
import { placeCard } from './placement';

const area: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const card = { width: 300, height: 120 };

function expectValid(target: Rect, placed: ReturnType<typeof placeCard>) {
  expect(containsRect(area, placed.rect)).toBe(true);
  if (placed.clean) expect(intersectionArea(placed.rect, target)).toBe(0);
}

describe('placeCard', () => {
  it('prefers the right side, vertically centred on the target', () => {
    const target = { x: 400, y: 500, width: 100, height: 40 };
    const p = placeCard(target, card, area);
    expect(p.side).toBe('right');
    expect(p.rect).toEqual({ x: 514, y: 460, width: 300, height: 120 });
    expectValid(target, p);
  });

  it('goes left when the target is near the right edge', () => {
    const target = { x: 1800, y: 500, width: 100, height: 40 };
    const p = placeCard(target, card, area);
    expect(p.side).toBe('left');
    expectValid(target, p);
  });

  it('goes below when the target spans the width', () => {
    const target = { x: 10, y: 100, width: 1900, height: 40 };
    const p = placeCard(target, card, area);
    expect(p.side).toBe('below');
    expectValid(target, p);
  });

  it('goes above when the target spans the width at the bottom', () => {
    const target = { x: 10, y: 950, width: 1900, height: 60 };
    const p = placeCard(target, card, area);
    expect(p.side).toBe('above');
    expectValid(target, p);
  });

  it('clamps vertically so the card stays on screen near a top corner', () => {
    const target = { x: 20, y: 0, width: 40, height: 20 };
    const p = placeCard(target, card, area);
    expect(p.side).toBe('right');
    expect(p.rect.y).toBe(0);
    expectValid(target, p);
  });

  it('never leaves the work area even for a full-screen target', () => {
    const target = { x: 0, y: 0, width: 1920, height: 1040 };
    const p = placeCard(target, card, area);
    expect(p.clean).toBe(false);
    expect(containsRect(area, p.rect)).toBe(true);
  });

  it('minimises overlap when nothing fits cleanly', () => {
    const target = { x: 0, y: 0, width: 1700, height: 1040 };
    const p = placeCard(target, card, area);
    expect(p.clean).toBe(false);
    // Right-hand strip is 220 px wide: the card must overlap, but as little as possible.
    expect(p.rect.x).toBe(1920 - 300);
    expect(intersectionArea(p.rect, target)).toBe(80 * 120);
  });

  it('works in a non-zero-origin area', () => {
    const shifted = { x: 0, y: 37, width: 1512, height: 945 };
    const target = { x: 600, y: 37, width: 80, height: 20 };
    const p = placeCard(target, card, shifted);
    expect(containsRect(shifted, p.rect)).toBe(true);
    expect(p.clean).toBe(true);
  });
});
