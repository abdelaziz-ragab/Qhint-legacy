/**
 * Phase 1 debug command: capture every display, draw rings at known image-pixel boxes, then
 * re-capture to check that (a) rings land where the boxes say and (b) our overlay stays out of
 * captures. Results are geometry and scores only; no screen content is logged.
 */
import type { BrowserWindow } from 'electron';
import { type BBox, type Rect, bboxToRect, inflate } from '../../shared/geometry';
import type { OverlayRing, OverlayScene } from '../../shared/overlay-scene';
import { captureDisplays, type DisplayCapture } from '../capture/capture';
import { HIDE_DURING_CAPTURE, withOwnWindowsHidden } from '../capture/guard';
import { LEAK_SCORE_LIMIT, ringLeakScore } from '../capture/leak-check';
import { imageBBoxToLocal, localWorkArea } from '../coords/coords';
import type { OverlayManager } from '../overlay/manager';
import { ensureScreenPermission } from '../permissions';

export const RING_BORDER = 3; // keep in sync with overlay.css
const RING_PAD = 4;
const EDGE_PAD = -RING_BORDER;

export interface DebugBox {
  name: 'edges' | 'center' | 'corner';
  bbox: BBox;
  pad: number;
  tone: NonNullable<OverlayRing['tone']>;
}

/** Boxes in image pixels: full image (traces the display edges), centre half, small corner box. */
export function debugBoxes(width: number, height: number): DebugBox[] {
  const cx = Math.round(width * 0.05);
  const cy = Math.round(height * 0.08);
  return [
    { name: 'edges', bbox: [0, 0, width, height], pad: EDGE_PAD, tone: 'debug' },
    {
      name: 'center',
      bbox: [width / 4, height / 4, (width * 3) / 4, (height * 3) / 4],
      pad: RING_PAD,
      tone: 'primary',
    },
    { name: 'corner', bbox: [cx, cy, cx + 120, cy + 48], pad: RING_PAD, tone: 'debug' },
  ];
}

/** Where the ring stroke runs, in image pixels (for the leak check). */
function strokeRectInImage(box: DebugBox, c: DisplayCapture): Rect {
  const k = c.image.width / c.display.bounds.width; // image px per DIP
  return inflate(bboxToRect(box.bbox), (box.pad + RING_BORDER / 2) * k);
}

export interface DisplayDebugResult {
  label: string;
  displayId: number;
  scaleFactor: number;
  bounds: Rect;
  image: { width: number; height: number };
  matchMethod: DisplayCapture['matchMethod'];
  boxes: (DebugBox & { local: Rect })[];
  /** Fraction of ring-edge pixels visible in a capture taken without hiding our windows. */
  leakWithoutHiding: number | null;
  /** Same, with the macOS hide-during-capture guard (no-op on Windows). */
  leakWithGuard: number | null;
}

export interface DebugRun {
  startedAt: number;
  platform: NodeJS.Platform;
  hideDuringCapture: boolean;
  displays: DisplayDebugResult[];
  skippedDisplayIds: number[];
  overlayBounds: ReturnType<OverlayManager['diagnostics']>;
  captures: {
    before: DisplayCapture[];
    afterRaw: DisplayCapture[];
    afterGuarded: DisplayCapture[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sceneFor(c: DisplayCapture, boxes: DebugBox[], locals: Rect[]): OverlayScene {
  const { display } = c;
  const pct = Math.round(display.scaleFactor * 100);
  return {
    rings: boxes.map((b, i) => ({ rect: locals[i]!, pad: b.pad, tone: b.tone })),
    card: {
      anchor: locals[1]!,
      title: `${c.label} · display ${display.id} · ${pct}%`,
      body:
        `image ${c.image.width}×${c.image.height} px → ` +
        `${display.bounds.width}×${display.bounds.height} DIP at ` +
        `(${display.bounds.x}, ${display.bounds.y}) · match: ${c.matchMethod}`,
    },
    workArea: localWorkArea(display),
  };
}

function leak(before: DisplayCapture, after: DisplayCapture | undefined, rings: Rect[]) {
  if (!after || !before.bitmap || !after.bitmap) return null;
  if (after.image.width !== before.image.width || after.image.height !== before.image.height) {
    return null;
  }
  return ringLeakScore(
    { ...before.image, pixels: before.bitmap },
    { ...after.image, pixels: after.bitmap },
    rings,
  );
}

export async function runDebugRings(
  overlays: OverlayManager,
  ownWindows: () => BrowserWindow[],
): Promise<DebugRun | null> {
  if (!(await ensureScreenPermission())) return null;
  const startedAt = Date.now();

  overlays.clearAll();
  await sleep(150);

  const before = await withOwnWindowsHidden(ownWindows(), () =>
    captureDisplays({ keepBitmap: true }),
  );

  const perDisplay = before.captures.map((c) => {
    const boxes = debugBoxes(c.image.width, c.image.height);
    const locals = boxes.map((b) => imageBBoxToLocal(b.bbox, c.image, c.display));
    overlays.render(c.display.id, sceneFor(c, boxes, locals));
    return { c, boxes, locals };
  });

  await sleep(500); // let overlays paint

  const afterRaw = await withOwnWindowsHidden(
    ownWindows(),
    () => captureDisplays({ keepBitmap: true }),
    false,
  );
  const afterGuarded = await withOwnWindowsHidden(ownWindows(), () =>
    captureDisplays({ keepBitmap: true }),
  );

  const displays: DisplayDebugResult[] = perDisplay.map(({ c, boxes, locals }) => {
    const strokes = boxes.map((b) => strokeRectInImage(b, c));
    const find = (list: DisplayCapture[]) => list.find((x) => x.display.id === c.display.id);
    return {
      label: c.label,
      displayId: c.display.id,
      scaleFactor: c.display.scaleFactor,
      bounds: c.display.bounds,
      image: c.image,
      matchMethod: c.matchMethod,
      boxes: boxes.map((b, i) => ({ ...b, local: locals[i]! })),
      leakWithoutHiding: leak(c, find(afterRaw.captures), strokes),
      leakWithGuard: leak(c, find(afterGuarded.captures), strokes),
    };
  });

  return {
    startedAt,
    platform: process.platform,
    hideDuringCapture: HIDE_DURING_CAPTURE,
    displays,
    skippedDisplayIds: before.skippedDisplayIds,
    overlayBounds: overlays.diagnostics(),
    captures: {
      before: before.captures,
      afterRaw: afterRaw.captures,
      afterGuarded: afterGuarded.captures,
    },
  };
}

function verdict(score: number | null): string {
  if (score === null) return 'n/a';
  return `${score.toFixed(2)} (${score > LEAK_SCORE_LIMIT ? 'VISIBLE in capture' : 'clean'})`;
}

/** Plain-text summary for the dialog and the console. */
export function summarize(run: DebugRun): string {
  const lines = run.displays.map((d) =>
    [
      `${d.label}: display ${d.displayId}, ${Math.round(d.scaleFactor * 100)}%, ` +
        `${d.bounds.width}×${d.bounds.height} DIP at (${d.bounds.x}, ${d.bounds.y}), ` +
        `image ${d.image.width}×${d.image.height}, match ${d.matchMethod}`,
      `  overlay in capture without hiding: ${verdict(d.leakWithoutHiding)}`,
      `  overlay in capture with guard:     ${verdict(d.leakWithGuard)}`,
    ].join('\n'),
  );
  const mismatched = run.overlayBounds.filter(
    (o) =>
      o.expected.x !== o.actual.x ||
      o.expected.y !== o.actual.y ||
      o.expected.width !== o.actual.width ||
      o.expected.height !== o.actual.height,
  );
  if (run.skippedDisplayIds.length > 0) {
    lines.push(`Skipped displays (no safe capture match): ${run.skippedDisplayIds.join(', ')}`);
  }
  lines.push(
    mismatched.length === 0
      ? 'Overlay windows: bounds match every display.'
      : `Overlay windows with wrong bounds: ${mismatched.map((m) => m.displayId).join(', ')}`,
  );
  return lines.join('\n');
}
