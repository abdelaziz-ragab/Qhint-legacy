import type { Rect } from '../../shared/geometry';

/**
 * New outer window frame that moves the measured drawing area onto the expected one. Works
 * whatever extra the OS adds around the drawing area (e.g. macOS's invisible title strip on
 * panel windows), because it only applies the difference. Pure.
 */
export function correctedFrame(frame: Rect, expected: Rect, actual: Rect): Rect {
  return {
    x: frame.x + (expected.x - actual.x),
    y: frame.y + (expected.y - actual.y),
    width: frame.width + (expected.width - actual.width),
    height: frame.height + (expected.height - actual.height),
  };
}

/** Offset to apply to drawings so local display coordinates land correctly in the page. */
export function drawingOffset(
  displayOrigin: { x: number; y: number },
  pageOrigin: { x: number; y: number },
) {
  return { x: displayOrigin.x - pageOrigin.x, y: displayOrigin.y - pageOrigin.y };
}
