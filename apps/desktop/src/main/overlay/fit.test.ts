import { describe, expect, it } from 'vitest';
import { correctedFrame, drawingOffset } from './fit';

describe('correctedFrame', () => {
  it('fixes the macOS case: drawing area 32px taller and starting 32px above the display', () => {
    const expected = { x: 0, y: 0, width: 1512, height: 982 };
    const actual = { x: 0, y: -32, width: 1512, height: 1014 };
    const frame = { x: 0, y: -32, width: 1512, height: 1014 };
    expect(correctedFrame(frame, expected, actual)).toEqual({
      x: 0,
      y: 0,
      width: 1512,
      height: 982,
    });
  });

  it('keeps a hidden title strip when the frame reports one', () => {
    // Frame includes a 32px strip above the drawing area; only the drawing area must move.
    const expected = { x: 1512, y: 0, width: 5120, height: 1440 };
    const actual = { x: 1512, y: 10, width: 5120, height: 1440 };
    const frame = { x: 1512, y: -22, width: 5120, height: 1472 };
    expect(correctedFrame(frame, expected, actual)).toEqual({
      x: 1512,
      y: -32,
      width: 5120,
      height: 1472,
    });
  });

  it('is a no-op when already correct', () => {
    const r = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(correctedFrame(r, r, r)).toEqual(r);
  });
});

describe('drawingOffset', () => {
  it('shifts drawings down when the page starts above the display', () => {
    expect(drawingOffset({ x: 0, y: 0 }, { x: 0, y: -32 })).toEqual({ x: 0, y: 32 });
  });

  it('works with negative display origins', () => {
    expect(drawingOffset({ x: -1920, y: 0 }, { x: -1920, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
