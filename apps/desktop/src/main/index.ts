import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type Tray,
} from 'electron';
import { join, resolve } from 'node:path';
import { runDebugRings, summarize } from './debug/debug-rings';
import { writeDebugReport } from './debug/report';
import { formatAccelerator, hotkeyCandidates, registerFirstAvailable } from './hotkey';
import { MainWindow } from './main-window';
import { OverlayManager } from './overlay/manager';
import { appIcon } from './icons';
import { createTray } from './tray';
import { IPC, type AppInfo, type AuthStatus, type ProcedureLists } from '../shared/ipc';
import { AuthSession } from './auth/session';
import { captureDisplays, type DisplayCapture } from './capture/capture';
import { appPresence } from './apps/presence';
import { AxHelper } from './ax/helper';
import { listWindows, ownWindowFilter } from './apps/windows';
import { hasInputPermission, InputWatcher } from './input/watcher';
import type { VerifyResult } from '@qhint/schema';
import { withOwnWindowsHidden } from './capture/guard';
import { ensureScreenPermission } from './permissions';
import { GuideController } from './runner/controller';
import { ElementCacheProvider, GroundingEngine, ModelGroundingProvider } from './runner/grounding';
import { PanelWindow } from './runner/panel-window';
import { logGuideEvent, logLocateAttempt, logPresence } from './debug/locate-log';
import { SAMPLE_PROCEDURES, type SampleId } from './runner/samples';

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

/**
 * qhint:// links: the browser sign-in page opens qhint://signed-in so the OS brings Qhint to the
 * front (macOS 14+ won't let an app bring itself in front of the browser). The link carries no
 * data and only ever shows the main window.
 */
const PROTOCOL = 'qhint';
if (process.defaultApp && process.argv[1]) {
  // Development: register "electron <app path>" (Windows registry; macOS needs dev-setup.mjs).
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}
let onAppLink: () => void = () => {};
// macOS delivers links as an event (possibly before the app is ready).
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith(`${PROTOCOL}://`)) onAppLink();
});

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

  const panel = new PanelWindow();

  const ownWindows = () => [
    ...overlays.windows(),
    ...(mainWindow.window ? [mainWindow.window] : []),
    ...(panel.window() ? [panel.window()!] : []),
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
  /**
   * Bring Qhint in front of the browser. macOS: an explicit app activation. Windows only lets the
   * foreground app hand focus over, so briefly mark the window always-on-top (to verify on the
   * Windows checkpoint).
   */
  const bringToFront = (main: MainWindow) => {
    main.show();
    const win = main.window;
    if (!win) return;
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    } else {
      win.setAlwaysOnTop(true);
      win.focus();
      setTimeout(() => win.setAlwaysOnTop(false), 300);
    }
    win.focus();
  };

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
      // Bring Qhint back to the front the moment the browser hands over the sign-in.
      return await session.signIn(() => bringToFront(mainWindow));
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

  // Windows delivers qhint:// links by starting a second copy, which hands over to this one.
  app.on('second-instance', () => mainWindow.show());
  onAppLink = () => mainWindow.show();
  // macOS: clicking the Dock icon opens the Qhint window.
  app.on('activate', () => mainWindow.show());
  // ---------------------------------------------------------------- guides
  const postToDataApi = async (path: string, body: unknown) => {
    const base = session.dataApiUrl();
    if (!base) throw new Error('signed_out');
    return session.fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  const grounding = new GroundingEngine([
    new ElementCacheProvider(),
    new ModelGroundingProvider(postToDataApi),
  ]);
  const toScreens = (captures: DisplayCapture[]) =>
    captures.map((c) => ({
      label: c.label,
      width: c.image.width,
      height: c.image.height,
      jpeg: c.jpeg.toString('base64'),
    }));
  const axHelper = new AxHelper();
  app.on('will-quit', () => axHelper.stop());
  const guide = new GuideController({
    overlays,
    // Accessibility needs the same macOS permission as input watching.
    elements: async (pid) => (hasInputPermission(false) ? axHelper.elements(pid) : null),
    frontmost: () => axHelper.frontmost(),
    panel,
    capture: async (displayIds) =>
      (await withOwnWindowsHidden(ownWindows(), () => captureDisplays({ displayIds }))).captures,
    locate: (step, captures, opts) => grounding.locate(step, captures, opts),
    verify: async (step, before, after) => {
      const res = await postToDataApi('/verify', {
        step,
        before: toScreens(before),
        after: toScreens(after),
        appCategory: step.app.kind,
      });
      if (!res.ok) throw new Error(`verify_${res.status}`);
      return ((await res.json()) as { result: VerifyResult }).result;
    },
    // The window list needs the same permission as input watching on macOS.
    presence: async (stepApp) => {
      if (!hasInputPermission(false)) {
        if (DEBUG_TOOLS) logPresence(stepApp.name, null, []);
        return null;
      }
      const windows = await listWindows();
      const own = ownWindowFilter();
      const result = appPresence(stepApp, windows, own);
      if (DEBUG_TOOLS)
        logPresence(
          stepApp.name,
          result,
          windows.filter((w) => !own(w)),
        );
      return result;
    },
    input: new InputWatcher(),
    ...(DEBUG_TOOLS ? { onAttempt: logLocateAttempt, log: logGuideEvent } : {}),
    reportGap: async (step, stepIndex) => {
      await postToDataApi('/gaps', {
        kind: 'runner_stuck',
        description:
          `Couldn't find the target for step ${stepIndex + 1}: ${step.instruction}`.slice(0, 2000),
        stepId: step.id,
      });
    },
  });
  panel.onAction((action) => guide.act(action));

  if (DEBUG_TOOLS) {
    ipcMain.handle(
      IPC.runSample,
      async (e, id: unknown): Promise<{ ok: boolean; error?: string } | null> => {
        if (!fromMainWindow(e)) return null;
        if (typeof id !== 'string' || !(id in SAMPLE_PROCEDURES))
          return { ok: false, error: 'unknown_sample' };
        if (!session.status().signedIn) return { ok: false, error: 'sign_in_required' };
        if (!(await ensureScreenPermission())) return { ok: false, error: 'screen_permission' };
        // Ask once for the permission that lets Qhint follow clicks and see which app is open.
        if (!hasInputPermission(false)) hasInputPermission(true);
        mainWindow.window?.hide(); // get out of the way of the app being guided
        guide.start(SAMPLE_PROCEDURES[id as SampleId]);
        return { ok: true };
      },
    );
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    overlays.dispose();
    panel.dispose();
    tray?.destroy();
  });

  mainWindow.show();
}

// Closing the window hides it; Qhint keeps running in the tray / Dock until Quit.
app.on('window-all-closed', () => {});
