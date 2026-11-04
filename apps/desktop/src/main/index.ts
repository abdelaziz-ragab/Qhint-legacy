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
import { appIcon } from './icons';
import { createTray } from './tray';
import { IPC, type AppInfo, type AuthStatus, type ProcedureLists } from '../shared/ipc';
import { AuthSession } from './auth/session';

// Dev only: QHINT_DEBUG_PORT=9222 exposes Chrome DevTools Protocol for inspecting our windows.
const debugPort = process.env.QHINT_DEBUG_PORT;
if (!app.isPackaged && debugPort && /^\d{2,5}$/.test(debugPort)) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

/**
 * Developer tools (debug rings, report, dialog) exist only in development builds. Employees using
 * a packaged build never see them: only the guides themselves are ever drawn on screen.
 */
const DEBUG_TOOLS = !app.isPackaged;

/** Control plane address. Development default: local control-api. */
const CONTROL_API_URL = process.env.QHINT_CONTROL_API_URL ?? 'http://127.0.0.1:8081';

// Module-level so the tray icon isn't garbage-collected.
let tray: Tray | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(start);
}

function start() {
  // Dock icon (macOS) until the real logo is packaged.
  if (process.platform === 'darwin') app.dock?.setIcon(appIcon(512));

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
      {
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
    ...(DEBUG_TOOLS
      ? {
          onDebugRings: () => void debugRings(),
          onClearOverlay: () => void overlays.clearAll(),
        }
      : {}),
    onQuit: () => app.quit(),
  });

  // Only the main window's renderer may call these.
  const fromMainWindow = (e: IpcMainInvokeEvent) =>
    mainWindow.window !== undefined && e.sender.id === mainWindow.window.webContents.id;

  ipcMain.handle(IPC.appInfo, (e): AppInfo | null =>
    fromMainWindow(e)
      ? {
          hotkey: hotkeyLabel,
          hotkeyIsFallback: hotkey?.isFallback ?? false,
          debugTools: DEBUG_TOOLS,
        }
      : null,
  );
  if (DEBUG_TOOLS) {
    ipcMain.handle(IPC.debugRings, (e) => (fromMainWindow(e) ? debugRings() : null));
    ipcMain.handle(IPC.clearOverlay, (e) => {
      if (fromMainWindow(e)) return overlays.clearAll();
    });
  }

  // ---------------------------------------------------------------- sign-in + data
  const session = new AuthSession(CONTROL_API_URL);
  const restored = session.restore().catch(() => session.status());

  const toStatus = (err?: unknown): AuthStatus =>
    err instanceof Error ? { signedIn: false, error: err.message } : session.status();

  ipcMain.handle(IPC.authStatus, async (e) =>
    fromMainWindow(e) ? (await restored, session.status()) : null,
  );
  ipcMain.handle(IPC.authSignIn, async (e) => {
    if (!fromMainWindow(e)) return null;
    try {
      const status = await session.signIn();
      mainWindow.show(); // bring Qhint back to the front after the browser
      return status;
    } catch (err) {
      return toStatus(err);
    }
  });
  ipcMain.handle(IPC.authSignOut, async (e) => {
    if (!fromMainWindow(e)) return null;
    await session.signOut();
    return session.status();
  });
  ipcMain.handle(IPC.procedures, async (e): Promise<ProcedureLists | null> => {
    const base = session.dataApiUrl();
    if (!fromMainWindow(e) || !base) return null;
    const list = async (scope: 'company' | 'mine') => {
      const res = await session.fetch(`${base}/procedures?scope=${scope}`);
      if (!res.ok) throw new Error(`procedures_${res.status}`);
      return ((await res.json()) as { procedures: ProcedureLists['company'] }).procedures;
    };
    const [company, mine] = await Promise.all([list('company'), list('mine')]);
    return { company, mine };
  });

  app.on('second-instance', () => mainWindow.show());
  // macOS: clicking the Dock icon opens the Qhint window.
  app.on('activate', () => mainWindow.show());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    overlays.dispose();
    tray?.destroy();
  });

  mainWindow.show();
}

// Closing the window hides it; Qhint keeps running in the tray / Dock until Quit.
app.on('window-all-closed', () => {});
