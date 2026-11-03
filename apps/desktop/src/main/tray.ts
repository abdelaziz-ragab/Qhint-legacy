import { Menu, Tray } from 'electron';
import { trayIcon } from './icons';

export interface TrayActions {
  hotkeyLabel: string | null;
  hotkeyIsFallback: boolean;
  onOpen: () => void;
  /** Development builds only. */
  onDebugRings?: () => void;
  onClearOverlay?: () => void;
  onQuit: () => void;
}

export function createTray(actions: TrayActions): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip('Qhint');

  const hotkeyLine = actions.hotkeyLabel
    ? `Open Qhint (${actions.hotkeyLabel}${actions.hotkeyIsFallback ? ', fallback' : ''})`
    : 'Open Qhint (hotkey unavailable)';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hotkeyLine, click: actions.onOpen },
      ...(actions.onDebugRings && actions.onClearOverlay
        ? [
            { type: 'separator' as const },
            { label: 'Debug: capture + draw rings', click: actions.onDebugRings },
            { label: 'Clear overlay', click: actions.onClearOverlay },
          ]
        : []),
      { type: 'separator' },
      { label: 'Quit Qhint', click: actions.onQuit },
    ]),
  );
  // Windows: left-click opens the panel (macOS shows the menu on click).
  if (process.platform === 'win32') tray.on('click', actions.onOpen);
  return tray;
}
