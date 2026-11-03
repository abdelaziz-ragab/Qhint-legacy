import { nativeImage, type NativeImage } from 'electron';
import { drawRingIcon } from './tray-icon';

/** Placeholder icons (drawn in code) until the real logo is added. */

export function trayIcon(): NativeImage {
  const isMac = process.platform === 'darwin';
  const image = nativeImage.createEmpty();
  for (const scaleFactor of isMac ? [1, 2] : [1, 1.25, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    const { pixels } = drawRingIcon(size, isMac ? 'template' : 'light-on-dark');
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: pixels });
  }
  if (isMac) image.setTemplateImage(true);
  return image;
}

/** Dock (macOS) and window/taskbar (Windows) icon. */
export function appIcon(size = 256): NativeImage {
  const { pixels } = drawRingIcon(size, 'light-on-dark');
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
