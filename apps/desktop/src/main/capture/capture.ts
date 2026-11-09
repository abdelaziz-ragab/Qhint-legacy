import { desktopCapturer, nativeImage, screen, type Display, type NativeImage } from 'electron';
import {
  aspectMismatch,
  DEFAULT_LONG_SIDE,
  orderDisplaysCursorFirst,
  orderTilesCursorFirst,
  planCapture,
  type CaptureFrame,
  type DisplayGeometry,
} from '../coords/coords';
import { matchSourcesToDisplays, MAX_ASPECT_MISMATCH, type SourceMatch } from './match-sources';

/** One captured image: a whole display, or one tile of a very wide / tall display. */
export interface DisplayCapture extends CaptureFrame {
  /** Label used in prompts: "screen_1" is always the image under the cursor. */
  label: string;
  tile: { index: number; count: number };
  jpeg: Buffer;
  /** How the image was tied to its display: by source id, by shape, or taken natively. */
  matchMethod: SourceMatch['method'] | 'native';
  capturedAt: number;
  /** Kept only when requested (debug); raw 4-byte-per-pixel data, platform channel order. */
  bitmap?: Buffer;
}

export interface CaptureResult {
  captures: DisplayCapture[];
  /** Displays we could not capture or could not match safely (ids only). */
  skippedDisplayIds: number[];
}

export interface CaptureOptions {
  longSide?: number;
  /** JPEG quality 0-100. */
  quality?: number;
  keepBitmap?: boolean;
  /** Only these displays (e.g. the one the guided app is on). Default: all. */
  displayIds?: number[];
  /**
   * Take each display's image another way (macOS helper: leaves Qhint's windows out). JPEG at the
   * requested pixel size, or null when it fails (that display is then skipped).
   */
  grab?: (displayId: number, size: { width: number; height: number }) => Promise<Buffer | null>;
}

export function toGeometry(d: Display): DisplayGeometry {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

export function currentDisplays(): DisplayGeometry[] {
  return screen.getAllDisplays().map(toGeometry);
}

/** Capture every display (cursor display and tile first). */
export async function captureDisplays(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const longSide = opts.longSide ?? DEFAULT_LONG_SIDE;
  const quality = opts.quality ?? 80;

  const cursor = screen.getCursorScreenPoint();
  const all = currentDisplays();
  const wanted = opts.displayIds?.length ? all.filter((d) => opts.displayIds!.includes(d.id)) : all;
  const displays = orderDisplaysCursorFirst(wanted.length ? wanted : all, cursor);
  const plans = new Map(displays.map((d) => [d.id, planCapture(d, longSide)]));
  // Thumbnails are scaled to fit inside this square, keeping aspect; big enough for every plan.
  const box = Math.max(...[...plans.values()].map((p) => Math.max(p.full.width, p.full.height)));
  const sources = opts.grab
    ? []
    : await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: box, height: box },
        fetchWindowIcons: false,
      });

  const matches = opts.grab
    ? []
    : matchSourcesToDisplays(
        sources.map((s) => ({
          id: s.id,
          displayId: s.display_id,
          thumbnailSize: s.thumbnail.getSize(),
        })),
        displays,
      );
  const grabbed = opts.grab
    ? await Promise.all(
        displays.map(async (d) => {
          const jpeg = await opts.grab!(d.id, plans.get(d.id)!.full).catch(() => null);
          return jpeg ? nativeImage.createFromBuffer(jpeg) : undefined;
        }),
      )
    : [];

  const captures: DisplayCapture[] = [];
  const skippedDisplayIds: number[] = [];
  const capturedAt = Date.now();

  for (const [i, display] of displays.entries()) {
    const plan = plans.get(display.id)!;
    const match = opts.grab
      ? { method: 'native' as const }
      : matches.find((m) => m.displayId === display.id);
    const thumb: NativeImage | undefined = opts.grab
      ? grabbed[i]
      : sources.find((s) => s.id === (match as SourceMatch | undefined)?.sourceId)?.thumbnail;
    if (!match || !thumb || thumb.isEmpty()) {
      skippedDisplayIds.push(display.id);
      continue;
    }
    if (aspectMismatch(thumb.getSize(), display) > MAX_ASPECT_MISMATCH) {
      skippedDisplayIds.push(display.id);
      continue;
    }

    const size = thumb.getSize();
    const full =
      size.width === plan.full.width && size.height === plan.full.height
        ? thumb
        : thumb.resize({ width: plan.full.width, height: plan.full.height, quality: 'best' });

    for (const tile of orderTilesCursorFirst(plan.tiles, display, cursor)) {
      const img = plan.tiles.length === 1 ? full : full.crop(tile.crop);
      captures.push({
        label: `screen_${captures.length + 1}`,
        display,
        region: tile.region,
        image: tile.image,
        tile: { index: tile.index, count: tile.count },
        jpeg: img.toJPEG(quality),
        matchMethod: match.method,
        capturedAt,
        ...(opts.keepBitmap ? { bitmap: img.toBitmap() } : {}),
      });
    }
  }
  return { captures, skippedDisplayIds };
}
