import type { Point, Rect } from './geometry';

/** What one overlay window should draw. All rects are in that display's local DIP space. */
export interface OverlayScene {
  rings: OverlayRing[];
  card?: OverlayCard;
  /** Display work area in local DIP (excludes taskbar/menu bar); cards stay inside it. */
  workArea: Rect;
  /**
   * The display's top-left in global DIP. The page compares it with its own position and shifts
   * drawings by any difference, so rings stay exact even if the OS placed the window off by a bit.
   */
  origin: Point;
}

export interface OverlayRing {
  rect: Rect;
  /** Gap between the target and the ring; negative draws the ring inside the rect. */
  pad?: number;
  tone?: 'primary' | 'debug';
}

export interface OverlayCard {
  /** Rect the card should sit next to (usually the primary ring's rect). */
  anchor: Rect;
  title: string;
  body?: string;
}

export const OVERLAY_SCENE_CHANNEL = 'overlay:scene';
