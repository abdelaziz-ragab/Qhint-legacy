import { aspectMismatch, type DisplayGeometry } from '../coords/coords';
import type { Size } from '../../shared/geometry';

export interface SourceInfo {
  /** desktopCapturer source id, e.g. "screen:1:0". */
  id: string;
  /** desktopCapturer display_id; empty on some Windows setups. */
  displayId: string;
  thumbnailSize: Size;
}

export interface SourceMatch {
  displayId: number;
  sourceId: string;
  /** 'id' = matched by display_id; 'shape' = fallback by aspect ratio / order. */
  method: 'id' | 'shape';
}

/** Above this, an image almost certainly isn't a capture of that display. */
export const MAX_ASPECT_MISMATCH = 0.02;

function screenIndex(sourceId: string): number {
  const n = Number(sourceId.split(':')[1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Pair capture sources with displays. Uses display_id when present; otherwise pairs remaining
 * sources with remaining displays of matching shape, in a stable order. Displays that can't be
 * matched safely are left out (better no capture than a capture mapped to the wrong screen).
 */
export function matchSourcesToDisplays(
  sources: SourceInfo[],
  displays: DisplayGeometry[],
): SourceMatch[] {
  const matches: SourceMatch[] = [];
  const usedSources = new Set<string>();
  const unmatched: DisplayGeometry[] = [];

  for (const d of displays) {
    const s = sources.find((src) => src.displayId !== '' && src.displayId === String(d.id));
    if (s && !usedSources.has(s.id)) {
      matches.push({ displayId: d.id, sourceId: s.id, method: 'id' });
      usedSources.add(s.id);
    } else {
      unmatched.push(d);
    }
  }

  const remaining = sources
    .filter((s) => !usedSources.has(s.id))
    .sort((a, b) => screenIndex(a.id) - screenIndex(b.id));
  const orderedDisplays = [...unmatched].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y,
  );

  for (const d of orderedDisplays) {
    const fits = remaining.filter(
      (s) => !usedSources.has(s.id) && aspectMismatch(s.thumbnailSize, d) <= MAX_ASPECT_MISMATCH,
    );
    const sameShapeDisplays = orderedDisplays.filter(
      (o) => aspectMismatch(d.bounds, o) <= MAX_ASPECT_MISMATCH,
    );
    // Only safe when shapes are unique, or counts line up so order is the only tie-breaker.
    if (fits.length === 0) continue;
    if (fits.length > 1 && fits.length !== sameShapeDisplays.length) continue;
    const s = fits[0]!;
    matches.push({ displayId: d.id, sourceId: s.id, method: 'shape' });
    usedSources.add(s.id);
  }
  return matches;
}
