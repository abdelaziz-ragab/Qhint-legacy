/** Where on which display a located target is. Pure; no Electron. */
import type { LocateResult } from '@qhint/schema';
import type { Point, Rect } from '../../shared/geometry';
import { type CaptureFrame, imageBBoxToLocal, localToGlobal } from '../coords/coords';

export interface TargetPlacement {
  displayId: number;
  /** In the display's local DIP space (what the overlay draws in). */
  local: Rect;
  /** In global DIP (for positioning the step card window). */
  global: Rect;
}

/** Map a "found" result on screenshot `screen` to a display position; null if unknown screen. */
export function placeTarget(
  result: Extract<LocateResult, { kind: 'found' }>,
  frames: (CaptureFrame & { label: string })[],
): TargetPlacement | null {
  const frame = frames.find((f) => f.label === result.screen);
  if (!frame) return null;
  const local = imageBBoxToLocal(result.bbox, frame);
  return { displayId: frame.display.id, local, global: localToGlobal(local, frame.display) };
}

/** Pointer start: the mouse position if it's on the target's display, else just above-left of it. */
export function pointerStart(cursor: Point, displayBounds: Rect, target: Rect): Point {
  const inside =
    cursor.x >= displayBounds.x &&
    cursor.y >= displayBounds.y &&
    cursor.x < displayBounds.x + displayBounds.width &&
    cursor.y < displayBounds.y + displayBounds.height;
  if (inside) return { x: cursor.x - displayBounds.x, y: cursor.y - displayBounds.y };
  return { x: Math.max(0, target.x - 120), y: Math.max(0, target.y - 80) };
}
