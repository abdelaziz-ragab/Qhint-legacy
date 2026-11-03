import { type Rect, type Size, containsRect, inflate, intersectionArea } from './geometry';

export type CardSide = 'right' | 'left' | 'below' | 'above';

export interface CardPlacement {
  rect: Rect;
  side: CardSide;
  /** False when no side fit cleanly and the card was clamped into the area. */
  clean: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(v, min), max);
}

/**
 * Place a step card next to (never on) the target, inside `area` (e.g. the display work area).
 * Tries right, left, below, above. If none fits cleanly, picks the clamped candidate that covers
 * the least of the target. All rects share one coordinate space.
 */
export function placeCard(target: Rect, card: Size, area: Rect, gap = 14): CardPlacement {
  const minX = area.x;
  const maxX = area.x + area.width - card.width;
  const minY = area.y;
  const maxY = area.y + area.height - card.height;
  const midX = clamp(target.x + target.width / 2 - card.width / 2, minX, maxX);
  const midY = clamp(target.y + target.height / 2 - card.height / 2, minY, maxY);

  const candidates: { side: CardSide; x: number; y: number }[] = [
    { side: 'right', x: target.x + target.width + gap, y: midY },
    { side: 'left', x: target.x - gap - card.width, y: midY },
    { side: 'below', x: midX, y: target.y + target.height + gap },
    { side: 'above', x: midX, y: target.y - gap - card.height },
  ];

  const keepOut = inflate(target, gap / 2);
  for (const c of candidates) {
    const rect = { x: c.x, y: c.y, ...card };
    if (containsRect(area, rect) && intersectionArea(rect, keepOut) === 0) {
      return { rect, side: c.side, clean: true };
    }
  }

  let best: CardPlacement | undefined;
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const rect = { x: clamp(c.x, minX, maxX), y: clamp(c.y, minY, maxY), ...card };
    const overlap = intersectionArea(rect, target);
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      best = { rect, side: c.side, clean: false };
    }
  }
  return best!;
}
