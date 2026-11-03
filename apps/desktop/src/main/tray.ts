import { Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { drawRingIcon } from './tray-icon';

export interface TrayActions {
  hotkeyLabel: string | null;
  hotkeyIsFallback: boolean;
  onOpen: () => void;
  onDebugRings: () => void;
  onClearOverlay: () => void;
  onQuit: () => void;
}

function buildIcon(): NativeImage {
  const isMac = process.platform === 'darwin';
  const base = 16;
  const image = nativeImage.createEmpty();
  for (const scaleFactor of isMac ? [1, 2] : [1, 1.25, 1.5, 2]) {
    const size = Math.round(base * scaleFactor);
    const { pixels } = drawRingIcon(size, isMac ? 'template' : 'light-on-dark');
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: pixels });
  }
  if (isMac) image.setTemplateImage(true);
  return image;
}

export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(buildIcon());
  tray.setToolTip('Qhint');

  const hotkeyLine = actions.hotkeyLabel
    ? `Open Qhint (${actions.hotkeyLabel}${actions.hotkeyIsFallback ? ', fallback' : ''})`
    : 'Open Qhint (hotkey unavailable)';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkeyLine, click: actions.onOpen },
      { type: 'separator' },
      { label: 'Debug: capture + draw rings', click: actions.onDebugRings },
      { label: 'Clear overlay', click: actions.onClearOverlay },
      { type: 'separator' },
      { label: 'Quit Qhint', click: actions.onQuit },
    ]),
  );
  // Windows: left-click opens the panel (macOS shows the menu on click).
  if (process.platform === 'win32') tray.on('click', actions.onOpen);
  return tray;
}
