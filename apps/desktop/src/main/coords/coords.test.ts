import { describe, expect, it } from 'vitest';
import {
  aspectMismatch,
  displayForPoint,
  fullFrame,
  globalPointToImage,
  globalRectToImageBBox,
  imageBBoxToGlobal,
  imageBBoxToLocal,
  imagePointToGlobal,
  localWorkArea,
  orderDisplaysCursorFirst,
  orderTilesCursorFirst,
  physicalSize,
  planCapture,
  type CaptureFrame,
  type DisplayGeometry,
} from './coords';

function display(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor: number,
  workArea?: DisplayGeometry['workArea'],
): DisplayGeometry {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: workArea ?? { x, y, width, height },
    scaleFactor,
  };
}

// Real-world shapes (bounds are what Electron reports, in DIP).
const macBuiltIn = display(1, 0, 0, 1512, 982, 2, { x: 0, y: 37, width: 1512, height: 945 });
const win100 = display(2, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 });
const win150 = display(3, 0, 0, 1707, 960, 1.5); // 2560x1440 panel at 150%
const leftOfPrimary = display(4, -1920, 0, 1920, 1080, 1);
const abovePrimary = display(5, 0, -1080, 1920, 1080, 1.25);
const portrait = display(6, 1920, -420, 1080, 1920, 1);
const smallPanel = display(7, 0, 0, 1024, 768, 1);
const superUltrawide = display(8, 0, 0, 5120, 1440, 1); // 32:9, e.g. 49" monitors
const ultrawide = display(9, -3440, 0, 3440, 1440, 1); // 21:9, left of primary
const tallStrip = display(10, 0, 0, 1080, 3840, 1); // two portrait panels stacked

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

/** Frame for tile `i` of a display's capture plan. */
function tileFrame(d: DisplayGeometry, i = 0): CaptureFrame {
  const t = planCapture(d).tiles[i]!;
  return { display: d, region: t.region, image: t.image };
}

describe('planCapture: normal displays (one image)', () => {
  it('uses physical pixels (DIP x scale factor)', () => {
    expect(physicalSize(macBuiltIn)).toEqual({ width: 3024, height: 1964 });
    expect(physicalSize(win150)).toEqual({ width: 2561, height: 1440 });
  });

  it.each([
    ['mac retina', macBuiltIn, { width: 1280, height: 831 }],
    ['1080p @100%', win100, { width: 1280, height: 720 }],
    ['1440p @150%', win150, { width: 1280, height: 720 }],
    ['portrait', portrait, { width: 720, height: 1280 }],
    ['small panel is never upscaled', smallPanel, { width: 1024, height: 768 }],
  ])('%s', (_name, d, expected) => {
    const plan = planCapture(d);
    expect(plan.tiles).toHaveLength(1);
    expect(plan.full).toEqual(expected);
    expect(plan.tiles[0]!.image).toEqual(expected);
    expect(plan.tiles[0]!.region).toEqual({
      x: 0,
      y: 0,
      width: d.bounds.width,
      height: d.bounds.height,
    });
  });

  it('honours a custom long side', () => {
    expect(planCapture(win100, 640).full).toEqual({ width: 640, height: 360 });
  });
});

describe('planCapture: elongated displays (tiles)', () => {
  it('splits a 32:9 display into two 16:9 tiles at 1280x720', () => {
    const plan = planCapture(superUltrawide);
    expect(plan.full).toEqual({ width: 2560, height: 720 });
    expect(plan.tiles.map((t) => t.region)).toEqual([
      { x: 0, y: 0, width: 2560, height: 1440 },
      { x: 2560, y: 0, width: 2560, height: 1440 },
    ]);
    expect(plan.tiles.map((t) => t.image)).toEqual([
      { width: 1280, height: 720 },
      { width: 1280, height: 720 },
    ]);
    expect(plan.tiles.map((t) => t.crop.x)).toEqual([0, 1280]);
  });

  it('splits a 21:9 display into two tiles', () => {
    const plan = planCapture(ultrawide);
    expect(plan.tiles).toHaveLength(2);
    expect(plan.tiles[0]!.region.width).toBe(1720);
    expect(plan.tiles[0]!.image).toEqual({ width: 1280, height: 1072 });
    expect(plan.full).toEqual({ width: 2560, height: 1072 });
  });

  it('splits a very tall display vertically', () => {
    const plan = planCapture(tallStrip);
    expect(plan.tiles).toHaveLength(2);
    expect(plan.tiles[1]!.region).toEqual({ x: 0, y: 1920, width: 1080, height: 1920 });
    expect(plan.tiles[1]!.crop.y).toBe(plan.tiles[0]!.image.height);
  });

  it('tiles cover the display exactly with no gaps or overlap', () => {
    for (const d of [superUltrawide, ultrawide, tallStrip]) {
      const area = planCapture(d).tiles.reduce((s, t) => s + t.region.width * t.region.height, 0);
      expect(area).toBe(d.bounds.width * d.bounds.height);
    }
  });

  it('does not tile 16:10, 16:9 or 4:3 displays', () => {
    for (const d of [macBuiltIn, win100, smallPanel, portrait]) {
      expect(planCapture(d).tiles).toHaveLength(1);
    }
  });
});

describe('image -> screen', () => {
  it('maps a box on a 100% display', () => {
    const r = imageBBoxToLocal(
      [640, 360, 740, 410],
      fullFrame(win100, { width: 1280, height: 720 }),
    );
    expect(r).toEqual({ x: 960, y: 540, width: 150, height: 75 });
  });

  it('maps a box on a 150% display (non-integer DIP)', () => {
    const r = imageBBoxToLocal(
      [640, 360, 740, 410],
      fullFrame(win150, { width: 1280, height: 720 }),
    );
    close(r.x, 853.5);
    close(r.y, 480);
    close(r.width, 133.359375);
    close(r.height, 66.666667);
  });

  it('maps the whole image to the whole display on a retina mac', () => {
    const f = tileFrame(macBuiltIn);
    const r = imageBBoxToLocal([0, 0, f.image.width, f.image.height], f);
    expect(r).toEqual({ x: 0, y: 0, width: 1512, height: 982 });
  });

  it('offsets by display origin for global coordinates (negative x)', () => {
    const f = fullFrame(leftOfPrimary, { width: 1280, height: 720 });
    expect(imageBBoxToGlobal([0, 0, 128, 72], f)).toEqual({
      x: -1920,
      y: 0,
      width: 192,
      height: 108,
    });
  });

  it('offsets by display origin for global coordinates (negative y, 125%)', () => {
    const f = tileFrame(abovePrimary);
    expect(f.image).toEqual({ width: 1280, height: 720 });
    expect(imagePointToGlobal({ x: 1280, y: 720 }, f)).toEqual({ x: 1920, y: 0 });
  });

  it('handles a portrait display placed above-right with a negative origin', () => {
    const f = tileFrame(portrait);
    expect(imageBBoxToGlobal([360, 640, 720, 1280], f)).toEqual({
      x: 1920 + 540,
      y: -420 + 960,
      width: 540,
      height: 960,
    });
  });

  it('maps the second tile of a 32:9 display to its right half', () => {
    const f = tileFrame(superUltrawide, 1);
    expect(imageBBoxToLocal([0, 0, 1280, 720], f)).toEqual({
      x: 2560,
      y: 0,
      width: 2560,
      height: 1440,
    });
    expect(imageBBoxToLocal([640, 360, 740, 410], f)).toEqual({
      x: 3840,
      y: 720,
      width: 200,
      height: 100,
    });
  });

  it('maps tiles of a 21:9 display left of the primary to negative global x', () => {
    const f = tileFrame(ultrawide, 1);
    const r = imageBBoxToGlobal([0, 0, 1280, 1072], f);
    expect(r.x).toBe(-1720);
    close(r.width, 1720);
    close(r.height, 1440);
  });

  it('does not depend on scale factor once the image covers the region', () => {
    const image = { width: 1280, height: 720 };
    const a = fullFrame({ ...win100, scaleFactor: 1 }, image);
    const b = fullFrame({ ...win100, scaleFactor: 2 }, image);
    expect(imageBBoxToLocal([10, 10, 20, 20], a)).toEqual(imageBBoxToLocal([10, 10, 20, 20], b));
  });

  it('rejects an empty image size', () => {
    expect(() =>
      imageBBoxToLocal([0, 0, 1, 1], fullFrame(win100, { width: 0, height: 720 })),
    ).toThrow();
  });
});

describe('screen -> image (inverse)', () => {
  const frames: [string, CaptureFrame][] = [
    ['mac', tileFrame(macBuiltIn)],
    ['win100', tileFrame(win100)],
    ['win150', tileFrame(win150)],
    ['left', tileFrame(leftOfPrimary)],
    ['above', tileFrame(abovePrimary)],
    ['portrait', tileFrame(portrait)],
    ['32:9 tile 2', tileFrame(superUltrawide, 1)],
    ['21:9 tile 2', tileFrame(ultrawide, 1)],
    ['tall tile 2', tileFrame(tallStrip, 1)],
  ];

  it.each(frames)('round-trips points (%s)', (_name, f) => {
    for (const [fx, fy] of [
      [0, 0],
      [0.5, 0.5],
      [0.999, 0.001],
      [0.123, 0.987],
    ] as const) {
      const p = { x: f.image.width * fx, y: f.image.height * fy };
      const back = globalPointToImage(imagePointToGlobal(p, f), f);
      close(back.x, p.x);
      close(back.y, p.y);
    }
  });

  it('round-trips boxes', () => {
    const f = tileFrame(win150);
    const bbox = [101.5, 202.25, 333, 444] as const;
    const back = globalRectToImageBBox(imageBBoxToGlobal(bbox, f), f);
    back.forEach((v, i) => close(v, bbox[i]!));
  });
});

describe('work area', () => {
  it('is expressed relative to the display', () => {
    expect(localWorkArea(macBuiltIn)).toEqual({ x: 0, y: 37, width: 1512, height: 945 });
    const shifted = display(11, -1920, 0, 1920, 1080, 1, {
      x: -1920,
      y: 0,
      width: 1920,
      height: 1040,
    });
    expect(localWorkArea(shifted)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
});

describe('display and tile lookup', () => {
  const layout = [win100, leftOfPrimary, portrait];

  it('finds the display containing a point, including negative coordinates', () => {
    expect(displayForPoint({ x: -5, y: 10 }, layout).id).toBe(leftOfPrimary.id);
    expect(displayForPoint({ x: 5, y: 10 }, layout).id).toBe(win100.id);
    expect(displayForPoint({ x: 2000, y: -400 }, layout).id).toBe(portrait.id);
  });

  it('treats the right/bottom edge as belonging to the next display', () => {
    expect(displayForPoint({ x: 0, y: 0 }, layout).id).toBe(win100.id);
    expect(displayForPoint({ x: 1920, y: 100 }, layout).id).toBe(portrait.id);
  });

  it('falls back to the nearest display for points in gaps', () => {
    expect(displayForPoint({ x: 1000, y: -50 }, layout).id).toBe(win100.id);
    expect(displayForPoint({ x: -3000, y: 500 }, layout).id).toBe(leftOfPrimary.id);
  });

  it('orders the cursor display first, then left to right', () => {
    const order = orderDisplaysCursorFirst(layout, { x: 2100, y: 0 }).map((d) => d.id);
    expect(order).toEqual([portrait.id, leftOfPrimary.id, win100.id]);
  });

  it('orders the tile under the cursor first', () => {
    const tiles = planCapture(superUltrawide).tiles;
    expect(
      orderTilesCursorFirst(tiles, superUltrawide, { x: 4000, y: 10 }).map((t) => t.index),
    ).toEqual([1, 0]);
    expect(
      orderTilesCursorFirst(tiles, superUltrawide, { x: 10, y: 10 }).map((t) => t.index),
    ).toEqual([0, 1]);
    // Cursor on another display: keep natural order.
    expect(
      orderTilesCursorFirst(tiles, superUltrawide, { x: -50, y: 10 }).map((t) => t.index),
    ).toEqual([0, 1]);
  });

  it('uses global cursor coordinates for displays with negative origins', () => {
    const tiles = planCapture(ultrawide).tiles;
    expect(orderTilesCursorFirst(tiles, ultrawide, { x: -100, y: 10 }).map((t) => t.index)).toEqual(
      [1, 0],
    );
  });

  it('throws with no displays', () => {
    expect(() => displayForPoint({ x: 0, y: 0 }, [])).toThrow();
  });
});

describe('aspect mismatch', () => {
  it('is ~0 for a capture of the same display', () => {
    expect(aspectMismatch(planCapture(win150).full, win150)).toBeLessThan(0.002);
    expect(aspectMismatch(planCapture(macBuiltIn).full, macBuiltIn)).toBeLessThan(0.002);
    expect(aspectMismatch(planCapture(superUltrawide).full, superUltrawide)).toBeLessThan(0.002);
  });

  it('is large for a capture of a differently shaped display', () => {
    expect(aspectMismatch(planCapture(portrait).full, win100)).toBeGreaterThan(0.5);
  });
});
