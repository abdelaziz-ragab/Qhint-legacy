/**
 * Coordinate mapping between screenshot pixels and screen positions. Pure; no Electron imports.
 *
 * Spaces:
 * - image px:   pixels of one captured image (top-left origin).
 * - global DIP: Electron's virtual-desktop coordinates (what `screen` and BrowserWindow use).
 *               Can be negative (displays left of / above the primary).
 * - local DIP:  relative to one display's top-left corner; what an overlay window draws in,
 *               since each overlay window covers exactly one display.
 *
 * Each image covers a `region` of one display (the whole display, or one tile of a very wide or
 * tall display), so image px -> local DIP is: region origin + pixel * region size / image size.
 * scaleFactor only matters for choosing image sizes from physical pixels.
 */
import {
  type BBox,
  type Point,
  type Rect,
  type Size,
  bboxToRect,
  containsPoint,
} from '../../shared/geometry';

export interface DisplayGeometry {
  id: number;
  /** Global DIP. */
  bounds: Rect;
  /** Global DIP; bounds minus taskbar / menu bar / dock. */
  workArea: Rect;
  /** Physical pixels per DIP (1, 1.25, 1.5, 2, ...). */
  scaleFactor: number;
}

/** One captured image and the part of a display it shows. */
export interface CaptureFrame {
  display: DisplayGeometry;
  /** Local DIP rect of the display covered by the image. */
  region: Rect;
  /** Pixel size of the image. */
  image: Size;
}

export const DEFAULT_LONG_SIDE = 1280;
/** Displays more elongated than this (e.g. 32:9 or 21:9 ultrawides) are split into tiles. */
export const TILE_ASPECT_LIMIT = 2;
const TILE_TARGET_ASPECT = 16 / 9;
/**
 * DIP sizes are rounded to whole points, so a 32:9 display can come out a hair over two 16:9
 * widths (e.g. 2276x640 = 2.0004). Ignore overshoot this small instead of adding a sliver tile.
 */
const TILE_COUNT_TOLERANCE = 0.05;

/** Physical pixel size of a display. */
export function physicalSize(d: DisplayGeometry): Size {
  return {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  };
}

/** Fit a physical size so its long side is at most `longSide` (never upscales). */
function fitLongSide(phys: Size, longSide: number): Size {
  const k = Math.min(1, longSide / Math.max(phys.width, phys.height));
  return {
    width: Math.max(1, Math.round(phys.width * k)),
    height: Math.max(1, Math.round(phys.height * k)),
  };
}

export interface TilePlan {
  index: number;
  count: number;
  /** Local DIP region of the display this tile shows. */
  region: Rect;
  /** Pixel size of the tile image. */
  image: Size;
  /** Where the tile sits inside the full-display image of size `CapturePlan.full`. */
  crop: Rect;
}

export interface CapturePlan {
  /** Size to scale the whole-display capture to before cropping tiles out of it. */
  full: Size;
  tiles: TilePlan[];
}

/**
 * How to capture a display: one image with long side `longSide`, or for very elongated displays
 * N equal tiles that are each close to 16:9 and each get long side `longSide`. Keeps text at the
 * same detail as on a normal monitor instead of shrinking an ultrawide to a thin strip.
 */
export function planCapture(d: DisplayGeometry, longSide = DEFAULT_LONG_SIDE): CapturePlan {
  const { width, height } = d.bounds;
  const aspect = width / height;
  const horizontal = aspect > TILE_ASPECT_LIMIT;
  const vertical = 1 / aspect > TILE_ASPECT_LIMIT;
  const count =
    horizontal || vertical
      ? Math.max(
          2,
          Math.ceil((horizontal ? aspect : 1 / aspect) / TILE_TARGET_ASPECT - TILE_COUNT_TOLERANCE),
        )
      : 1;

  const regionW = horizontal ? width / count : width;
  const regionH = vertical ? height / count : height;
  const tileImage = fitLongSide(
    {
      width: Math.round(regionW * d.scaleFactor),
      height: Math.round(regionH * d.scaleFactor),
    },
    longSide,
  );
  const full = {
    width: horizontal ? tileImage.width * count : tileImage.width,
    height: vertical ? tileImage.height * count : tileImage.height,
  };

  const tiles: TilePlan[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    count,
    region: {
      x: horizontal ? regionW * i : 0,
      y: vertical ? regionH * i : 0,
      width: regionW,
      height: regionH,
    },
    image: tileImage,
    crop: {
      x: horizontal ? tileImage.width * i : 0,
      y: vertical ? tileImage.height * i : 0,
      width: tileImage.width,
      height: tileImage.height,
    },
  }));
  return { full, tiles };
}

/** Frame for an image that covers the whole display. */
export function fullFrame(d: DisplayGeometry, image: Size): CaptureFrame {
  return {
    display: d,
    region: { x: 0, y: 0, width: d.bounds.width, height: d.bounds.height },
    image,
  };
}

function scale(f: CaptureFrame) {
  if (f.image.width <= 0 || f.image.height <= 0) throw new Error('image size must be positive');
  return { sx: f.region.width / f.image.width, sy: f.region.height / f.image.height };
}

/** Image-pixel box -> local DIP rect on the frame's display. */
export function imageBBoxToLocal(bbox: BBox, f: CaptureFrame): Rect {
  const { sx, sy } = scale(f);
  const r = bboxToRect(bbox);
  return {
    x: f.region.x + r.x * sx,
    y: f.region.y + r.y * sy,
    width: r.width * sx,
    height: r.height * sy,
  };
}

/** Image-pixel box -> global DIP rect. */
export function imageBBoxToGlobal(bbox: BBox, f: CaptureFrame): Rect {
  return localToGlobal(imageBBoxToLocal(bbox, f), f.display);
}

/** Image-pixel point -> global DIP point. */
export function imagePointToGlobal(p: Point, f: CaptureFrame): Point {
  const { sx, sy } = scale(f);
  return {
    x: f.display.bounds.x + f.region.x + p.x * sx,
    y: f.display.bounds.y + f.region.y + p.y * sy,
  };
}

/** Global DIP point -> image pixel (inverse of imagePointToGlobal; may fall outside the image). */
export function globalPointToImage(p: Point, f: CaptureFrame): Point {
  const { sx, sy } = scale(f);
  return {
    x: (p.x - f.display.bounds.x - f.region.x) / sx,
    y: (p.y - f.display.bounds.y - f.region.y) / sy,
  };
}

/** Global DIP rect -> image-pixel box. */
export function globalRectToImageBBox(r: Rect, f: CaptureFrame): BBox {
  const a = globalPointToImage({ x: r.x, y: r.y }, f);
  const b = globalPointToImage({ x: r.x + r.width, y: r.y + r.height }, f);
  return [a.x, a.y, b.x, b.y];
}

export function localToGlobal(r: Rect, d: DisplayGeometry): Rect {
  return { ...r, x: r.x + d.bounds.x, y: r.y + d.bounds.y };
}

export function globalToLocal(r: Rect, d: DisplayGeometry): Rect {
  return { ...r, x: r.x - d.bounds.x, y: r.y - d.bounds.y };
}

/** The display's work area expressed in its own local DIP space. */
export function localWorkArea(d: DisplayGeometry): Rect {
  return globalToLocal(d.workArea, d);
}

/** Display containing the point, else the nearest one (by distance to its bounds). */
export function displayForPoint(p: Point, displays: DisplayGeometry[]): DisplayGeometry {
  if (displays.length === 0) throw new Error('no displays');
  const hit = displays.find((d) => containsPoint(d.bounds, p));
  if (hit) return hit;
  let best = displays[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const d of displays) {
    const dx = Math.max(d.bounds.x - p.x, 0, p.x - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - p.y, 0, p.y - (d.bounds.y + d.bounds.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** Displays ordered with the one under `cursor` first, the rest in stable left-to-right order. */
export function orderDisplaysCursorFirst(
  displays: DisplayGeometry[],
  cursor: Point,
): DisplayGeometry[] {
  const first = displayForPoint(cursor, displays);
  const rest = displays
    .filter((d) => d.id !== first.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return [first, ...rest];
}

/** Tiles of one display ordered with the tile under `cursor` (global DIP) first. */
export function orderTilesCursorFirst<T extends { region: Rect }>(
  tiles: T[],
  d: DisplayGeometry,
  cursor: Point,
): T[] {
  const local = { x: cursor.x - d.bounds.x, y: cursor.y - d.bounds.y };
  const i = tiles.findIndex((t) => containsPoint(t.region, local));
  if (i <= 0) return tiles;
  return [tiles[i]!, ...tiles.slice(0, i), ...tiles.slice(i + 1)];
}

/**
 * Relative difference between an image's aspect ratio and a display's. A large value means the
 * image probably isn't a capture of that display.
 */
export function aspectMismatch(image: Size, d: DisplayGeometry): number {
  const a = image.width / image.height;
  const b = d.bounds.width / d.bounds.height;
  return Math.abs(a - b) / b;
}
