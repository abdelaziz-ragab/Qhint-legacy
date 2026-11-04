import { describe, expect, it } from 'vitest';
import { planCapture, type DisplayGeometry } from '../coords/coords';
import { placeTarget, pointerStart } from './placement';

const laptop: DisplayGeometry = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 37, width: 1512, height: 945 },
  scaleFactor: 2,
};
const ultrawide: DisplayGeometry = {
  id: 2,
  bounds: { x: 1512, y: 0, width: 5120, height: 1440 },
  workArea: { x: 1512, y: 0, width: 5120, height: 1440 },
  scaleFactor: 1,
};
const frames = [
  { label: 'screen_1', display: laptop, ...planCapture(laptop).tiles[0]! },
  { label: 'screen_2', display: ultrawide, ...planCapture(ultrawide).tiles[0]! },
  { label: 'screen_3', display: ultrawide, ...planCapture(ultrawide).tiles[1]! },
];

describe('placeTarget', () => {
  it('maps a box on the second half of an ultrawide to local and global positions', () => {
    const p = placeTarget(
      {
        kind: 'found',
        screen: 'screen_3',
        bbox: [100, 50, 200, 80],
        confidence: 'high',
        label: 'x',
      },
      frames,
    );
    expect(p).toEqual({
      displayId: 2,
      local: { x: 2560 + 200, y: 100, width: 200, height: 60 },
      global: { x: 1512 + 2560 + 200, y: 100, width: 200, height: 60 },
    });
  });

  it('returns null for a screen label we did not send', () => {
    expect(
      placeTarget(
        { kind: 'found', screen: 'screen_9', bbox: [1, 1, 2, 2], confidence: 'high', label: '' },
        frames,
      ),
    ).toBeNull();
  });
});

describe('pointerStart', () => {
  const target = { x: 500, y: 300, width: 40, height: 20 };
  it('starts at the mouse when it is on the same display', () => {
    expect(pointerStart({ x: 1600, y: 50 }, ultrawide.bounds, target)).toEqual({ x: 88, y: 50 });
  });
  it('starts near the target when the mouse is on another display', () => {
    expect(pointerStart({ x: 10, y: 10 }, ultrawide.bounds, target)).toEqual({ x: 380, y: 220 });
  });
});
