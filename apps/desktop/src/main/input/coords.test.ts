import { describe, expect, it } from 'vitest';
import { clickHits, inputPointToDip } from './coords';

describe('inputPointToDip', () => {
  it('passes macOS points through', () => {
    expect(inputPointToDip({ x: 10, y: 20 }, 'darwin', () => ({ x: 0, y: 0 }))).toEqual({
      x: 10,
      y: 20,
    });
  });
  it('converts Windows physical pixels with the OS mapping', () => {
    expect(
      inputPointToDip({ x: 300, y: 150 }, 'win32', (p) => ({ x: p.x / 1.5, y: p.y / 1.5 })),
    ).toEqual({ x: 200, y: 100 });
  });
});

describe('clickHits', () => {
  const target = { x: 100, y: 100, width: 50, height: 20 };
  it('counts clicks inside or just around the target', () => {
    expect(clickHits({ x: 125, y: 110 }, target)).toBe(true);
    expect(clickHits({ x: 96, y: 98 }, target)).toBe(true);
  });
  it('rejects clicks clearly outside', () => {
    expect(clickHits({ x: 160, y: 110 }, target)).toBe(false);
    expect(clickHits({ x: 125, y: 140 }, target)).toBe(false);
  });
});
