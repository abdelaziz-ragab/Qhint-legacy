import type { Point } from '../../shared/geometry';

/**
 * Global input hooks report positions in the OS's native space: points (= DIP) on macOS, physical
 * pixels on Windows. Convert to global DIP, the space all Qhint geometry uses.
 */
export function inputPointToDip(
  p: Point,
  platform: NodeJS.Platform,
  screenToDip: (p: Point) => Point,
): Point {
  return platform === 'win32' ? screenToDip(p) : { x: p.x, y: p.y };
}

/** True if a click at `p` lands on `target`, allowing a few points of slack around it. */
export function clickHits(
  p: Point,
  target: { x: number; y: number; width: number; height: number },
  slack = 6,
): boolean {
  return (
    p.x >= target.x - slack &&
    p.y >= target.y - slack &&
    p.x <= target.x + target.width + slack &&
    p.y <= target.y + target.height + slack
  );
}
