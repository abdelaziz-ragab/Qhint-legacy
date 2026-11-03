/**
 * Placeholder tray icon (until the real logo): a ring with a centre dot, drawn in code so there
 * are no binary assets. Pure; returns raw 4-byte-per-pixel bitmaps. Colours are greyscale so the
 * BGRA/RGBA channel order doesn't matter.
 */

export interface IconBitmap {
  size: number;
  /** size*size*4 bytes, premultiplied alpha. */
  pixels: Buffer;
}

export type IconStyle = 'template' | 'light-on-dark';

function coverage(dist: number, inner: number, outer: number): number {
  // Anti-aliased band [inner, outer] with a 1px soft edge.
  const a = Math.min(1, Math.max(0, dist - inner + 0.5));
  const b = Math.min(1, Math.max(0, outer - dist + 0.5));
  return Math.min(a, b);
}

export function drawRingIcon(size: number, style: IconStyle): IconBitmap {
  const pixels = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size * 0.44;
  const stroke = Math.max(1.5, size * 0.12);
  const dot = size * 0.13;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - c, y - c);
      const fg = Math.max(coverage(dist, outer - stroke, outer), coverage(dist, -1, dot));
      let grey: number;
      let alpha: number;
      if (style === 'template') {
        // macOS template image: black + alpha; the system tints it for light/dark menu bars.
        grey = 0;
        alpha = fg;
      } else {
        // Windows: white mark on a dark disc, readable on light and dark taskbars.
        const disc = coverage(dist, -1, size * 0.5 - 0.5);
        alpha = disc;
        grey = disc > 0 ? fg * 255 + (1 - fg) * 32 : 0;
      }
      const i = (y * size + x) * 4;
      const a = Math.round(alpha * 255);
      const v = Math.round(grey * alpha); // premultiplied
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
      pixels[i + 3] = a;
    }
  }
  return { size, pixels };
}
