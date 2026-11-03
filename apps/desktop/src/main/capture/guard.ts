import type { BrowserWindow } from 'electron';

/**
 * On macOS, ScreenCaptureKit captures can include our windows even with content protection, so
 * we make them fully transparent for the duration of a capture. On Windows,
 * WDA_EXCLUDEFROMCAPTURE already removes them and this is a no-op.
 */
export const HIDE_DURING_CAPTURE = process.platform === 'darwin';

/** Time for the window server to composite a frame without our windows. */
const SETTLE_MS = 80;

export async function withOwnWindowsHidden<T>(
  windows: BrowserWindow[],
  fn: () => Promise<T>,
  enabled = HIDE_DURING_CAPTURE,
): Promise<T> {
  const targets = enabled ? windows.filter((w) => !w.isDestroyed() && w.isVisible()) : [];
  if (targets.length === 0) return fn();
  const previous = targets.map((w) => w.getOpacity());
  targets.forEach((w) => w.setOpacity(0));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  try {
    return await fn();
  } finally {
    targets.forEach((w, i) => {
      if (!w.isDestroyed()) w.setOpacity(previous[i] ?? 1);
    });
  }
}
