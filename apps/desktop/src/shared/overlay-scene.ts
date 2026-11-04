import type { Point, Rect } from './geometry';

/** What one overlay window should draw. All rects are in that display's local DIP space. */
export interface OverlayScene {
  rings: OverlayRing[];
  card?: OverlayCard;
  /** What employees see during a guide: pointer + click ring, or a text-field box. */
  guide?: OverlayGuide;
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

export interface OverlayGuide {
  /** 'done': the step was just completed (green check, no pointer). */
  kind: 'click' | 'type' | 'done';
  /** The target element, in local DIP. */
  rect: Rect;
  /** For type steps: what to type, shown on the box (e.g. "Type: 4"). */
  text?: string;
  /** Where the pointer starts gliding from (local DIP), usually the mouse position. */
  pointerFrom?: Point;
  /** Changes for every new target so the pointer animation restarts. */
  key: string;
}

export const OVERLAY_SCENE_CHANNEL = 'overlay:scene';
