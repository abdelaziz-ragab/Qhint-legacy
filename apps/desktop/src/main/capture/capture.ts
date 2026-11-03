import { desktopCapturer, screen, type Display, type NativeImage } from 'electron';
import type { Size } from '../../shared/geometry';
import {
  aspectMismatch,
  DEFAULT_LONG_SIDE,
  orderDisplaysCursorFirst,
  type DisplayGeometry,
} from '../coords/coords';
import { matchSourcesToDisplays, MAX_ASPECT_MISMATCH, type SourceMatch } from './match-sources';

export interface DisplayCapture {
  /** Label used in prompts: "screen_1" is always the display under the cursor. */
  label: string;
  display: DisplayGeometry;
  /** Pixel size of the captured image. */
  image: Size;
  jpeg: Buffer;
  matchMethod: SourceMatch['method'];
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
}

export function toGeometry(d: Display): DisplayGeometry {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
}

export function currentDisplays(): DisplayGeometry[] {
  return screen.getAllDisplays().map(toGeometry);
}

/** Capture every display, cursor display first. */
export async function captureDisplays(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const longSide = opts.longSide ?? DEFAULT_LONG_SIDE;
  const quality = opts.quality ?? 80;

  const displays = orderDisplaysCursorFirst(currentDisplays(), screen.getCursorScreenPoint());
  // Thumbnails are scaled to fit inside this box, keeping aspect: long side == longSide.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: longSide, height: longSide },
    fetchWindowIcons: false,
  });

  const matches = matchSourcesToDisplays(
    sources.map((s) => ({
      id: s.id,
      displayId: s.display_id,
      thumbnailSize: s.thumbnail.getSize(),
    })),
    displays,
  );

  const captures: DisplayCapture[] = [];
  const skippedDisplayIds: number[] = [];
  const capturedAt = Date.now();

  for (const display of displays) {
    const match = matches.find((m) => m.displayId === display.id);
    const thumb: NativeImage | undefined = sources.find((s) => s.id === match?.sourceId)?.thumbnail;
    const image = thumb?.getSize();
    if (!match || !thumb || thumb.isEmpty() || !image) {
      skippedDisplayIds.push(display.id);
      continue;
    }
    if (aspectMismatch(image, display) > MAX_ASPECT_MISMATCH) {
      skippedDisplayIds.push(display.id);
      continue;
    }
    captures.push({
      label: `screen_${captures.length + 1}`,
      display,
      image,
      jpeg: thumb.toJPEG(quality),
      matchMethod: match.method,
      capturedAt,
      ...(opts.keepBitmap ? { bitmap: thumb.toBitmap() } : {}),
    });
  }
  return { captures, skippedDisplayIds };
}
