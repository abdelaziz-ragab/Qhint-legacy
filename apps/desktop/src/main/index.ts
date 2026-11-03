import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type Tray,
} from 'electron';
import { join } from 'node:path';
import { runDebugRings, summarize } from './debug/debug-rings';
import { writeDebugReport } from './debug/report';
import { formatAccelerator, hotkeyCandidates, registerFirstAvailable } from './hotkey';
import { MainWindow } from './main-window';
import { OverlayManager } from './overlay/manager';
import { createTray } from './tray';
import { IPC, type AppInfo } from '../shared/ipc';

// Dev only: QHINT_DEBUG_PORT=9222 exposes Chrome DevTools Protocol for inspecting our windows.
const debugPort = process.env.QHINT_DEBUG_PORT;
if (!app.isPackaged && debugPort && /^\d{2,5}$/.test(debugPort)) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

// Module-level so the tray icon isn't garbage-collected.
let tray: Tray | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(start);
}

function start() {
  // Tray app: no Dock icon on macOS.
  if (process.platform === 'darwin') app.dock?.hide();

  const mainWindow = new MainWindow();
  const overlays = new OverlayManager();
  overlays.start();

  const ownWindows = () => [
    ...overlays.windows(),
    ...(mainWindow.window ? [mainWindow.window] : []),
  ];

  const hotkey = registerFirstAvailable(hotkeyCandidates(process.platform), (accelerator) =>
    globalShortcut.register(accelerator, () => mainWindow.toggle()),
  );
  if (!hotkey) console.warn('global hotkey: all candidates are taken');
  else if (hotkey.isFallback) console.warn('global hotkey: default taken, using fallback');
  const hotkeyLabel = hotkey ? formatAccelerator(hotkey.accelerator, process.platform) : null;

  let debugRunning = false;
  const debugRings = async (): Promise<string> => {
    if (debugRunning) return 'A debug run is already in progress.';
    debugRunning = true;
    try {
      const run = await runDebugRings(overlays, ownWindows);
      if (!run) return 'Screen Recording permission is needed first.';
      const summary = summarize(run);
      console.log(`debug rings\n${summary}`);
      if (!app.isPackaged) {
        const dir = await writeDebugReport(run);
        const { response } = await dialog.showMessageBox({
          message: 'Debug rings drawn',
          detail: summary,
          buttons: ['Open report', 'OK'],
          defaultId: 0,
        });
        if (response === 0) await shell.openPath(join(dir, 'report.html'));
      }
      return summary;
    } finally {
      debugRunning = false;
    }
  };

  tray = createTray({
    hotkeyLabel,
    hotkeyIsFallback: hotkey?.isFallback ?? false,
    onOpen: () => mainWindow.show(),
    onDebugRings: () => void debugRings(),
    onClearOverlay: () => overlays.clearAll(),
    onQuit: () => app.quit(),
  });

  // Only the main window's renderer may call these.
  const fromMainWindow = (e: IpcMainInvokeEvent) =>
    mainWindow.window !== undefined && e.sender.id === mainWindow.window.webContents.id;

  ipcMain.handle(IPC.appInfo, (e): AppInfo | null =>
    fromMainWindow(e)
      ? { hotkey: hotkeyLabel, hotkeyIsFallback: hotkey?.isFallback ?? false }
      : null,
  );
  ipcMain.handle(IPC.debugRings, (e) => (fromMainWindow(e) ? debugRings() : null));
  ipcMain.handle(IPC.clearOverlay, (e) => {
    if (fromMainWindow(e)) overlays.clearAll();
  });

  app.on('second-instance', () => mainWindow.show());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    overlays.dispose();
    tray?.destroy();
  });

  mainWindow.show();
}

// Tray app: closing windows never quits.
app.on('window-all-closed', () => {});
