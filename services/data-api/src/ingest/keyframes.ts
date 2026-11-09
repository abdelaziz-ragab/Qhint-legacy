/**
 * Which moments of a screen recording to show the model. Pure; works on small grayscale
 * thumbnails sampled at a fixed rate.
 *
 * A screen recording is mostly still screens separated by short changes (a menu opens, a dialog
 * appears). We keep the last frame of each still period (the screen just before the next action,
 * where its target is visible), plus a slower "floor" sample so slow changes like typing aren't
 * missed, minus near-duplicates, capped to a budget.
 */

export interface KeyframeOptions {
  /** Thumbnails per second. */
  fps: number;
  /** Mean absolute grey-level difference (0-255) that counts as "the screen changed". */
  changeThreshold?: number;
  /** Changes closer than this (seconds) are one transition (e.g. a dialog animating open). */
  mergeGapSeconds?: number;
  /** Take at least one frame this often (seconds), if the screen differs at all. */
  floorSeconds?: number;
  /** At most this many frames. */
  maxFrames?: number;
}

/** Mean absolute difference between two same-size grayscale thumbnails (0-255). */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}

/** Times (seconds) of the frames to keep, in order. */
export function selectKeyframes(thumbs: Uint8Array[], opts: KeyframeOptions): number[] {
  const n = thumbs.length;
  if (n === 0) return [];
  const fps = opts.fps;
  const threshold = opts.changeThreshold ?? 1.5;
  const mergeGap = Math.max(1, Math.round((opts.mergeGapSeconds ?? 0.75) * fps));
  const floor = Math.max(1, Math.round((opts.floorSeconds ?? 3) * fps));
  const maxFrames = Math.max(2, opts.maxFrames ?? 48);

  // 1. Where does the screen change?
  const changed: boolean[] = [false];
  for (let i = 1; i < n; i++) changed.push(frameDiff(thumbs[i - 1]!, thumbs[i]!) > threshold);

  // 2. Group nearby changes into transitions; keep the frame just before each one.
  const picks = new Set<number>([0]);
  let i = 1;
  while (i < n) {
    if (!changed[i]) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    let j = i + 1;
    while (j < n && j - end <= mergeGap) {
      if (changed[j]) end = j;
      j++;
    }
    picks.add(Math.max(0, start - 1)); // last still frame before the change
    i = end + 1;
  }
  picks.add(n - 1); // the final state

  // 3. Floor: slow changes (typing) add a frame now and then, if anything changed since.
  let last = 0;
  for (let k = 1; k < n; k++) {
    if (picks.has(k)) {
      last = k;
      continue;
    }
    if (k - last >= floor && frameDiff(thumbs[last]!, thumbs[k]!) > threshold / 3) {
      picks.add(k);
      last = k;
    }
  }

  // 4. Of two near-identical neighbours keep the later one: it's closer to the next action
  //    (e.g. the pointer is already over the target).
  const sorted = [...picks].sort((a, b) => a - b);
  const ordered: number[] = [];
  for (const k of sorted) {
    const prev = ordered.at(-1);
    if (prev !== undefined && frameDiff(thumbs[prev]!, thumbs[k]!) <= threshold / 3) ordered.pop();
    ordered.push(k);
  }

  // 5. Budget: repeatedly drop the frame most similar to the one before it (never first/last).
  while (ordered.length > maxFrames) {
    let worst = 1;
    let worstDiff = Infinity;
    for (let idx = 1; idx < ordered.length - 1; idx++) {
      const d = frameDiff(thumbs[ordered[idx - 1]!]!, thumbs[ordered[idx]!]!);
      if (d < worstDiff) {
        worstDiff = d;
        worst = idx;
      }
    }
    ordered.splice(worst, 1);
  }
  return ordered.map((k) => k / fps);
}
