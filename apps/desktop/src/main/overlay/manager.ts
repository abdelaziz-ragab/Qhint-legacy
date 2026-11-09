import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { OVERLAY_SCENE_CHANNEL, type OverlayScene } from '../../shared/overlay-scene';
import { localWorkArea, type DisplayGeometry } from '../coords/coords';
import { currentDisplays } from '../capture/capture';
import { correctedFrame } from './fit';
import { canShowToScreenSharing } from '../ax/helper';

/** The page's own view of where it is drawn, in global DIP. */
async function measureDrawingArea(win: BrowserWindow): Promise<Electron.Rectangle | null> {
  if (win.isDestroyed()) return null;
  try {
    const [x, y, width, height] = (await win.webContents.executeJavaScript(
      '[window.screenX, window.screenY, window.innerWidth, window.innerHeight]',
    )) as number[];
    return { x: x!, y: y!, width: width!, height: height! };
  } catch {
    return null;
  }
}

/**
 * Make the page's drawing area match the display exactly. The OS can add or shift a few points
 * (macOS panel windows on a display with a menu bar notch came out 32pt taller and higher), so
 * measure from inside the page and correct the outer frame by the difference.
 */
async function fitToDisplay(win: BrowserWindow, bounds: Electron.Rectangle): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = await measureDrawingArea(win);
    if (!actual) return false;
    if (sameRect(actual, bounds)) return true;
    if (win.isDestroyed()) return false;
    win.setBounds(correctedFrame(win.getBounds(), bounds, actual));
    await new Promise((r) => setTimeout(r, 50));
  }
  const actual = await measureDrawingArea(win);
  return actual !== null && sameRect(actual, bounds);
}

function emptyScene(display: DisplayGeometry): OverlayScene {
  return { rings: [], workArea: localWorkArea(display), origin: display.bounds };
}

export function sameRect(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

interface OverlayEntry {
  display: DisplayGeometry;
  win: BrowserWindow;
  ready: boolean;
  pending?: OverlayScene;
  /** Serialises fit + draw so scenes arrive in order. */
  queue: Promise<void>;
}

/**
 * One transparent, click-through, always-on-top window per display. Each window covers exactly
 * its display, so scenes are drawn in that display's local DIP space.
 */
export class OverlayManager {
  private entries = new Map<number, OverlayEntry>();
  private rebuildTimer: NodeJS.Timeout | undefined;
  private readonly onDisplaysChanged = () => {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), 300);
  };

  start(): void {
    this.rebuild();
    screen.on('display-added', this.onDisplaysChanged);
    screen.on('display-removed', this.onDisplaysChanged);
    screen.on('display-metrics-changed', this.onDisplaysChanged);
  }

  dispose(): void {
    screen.off('display-added', this.onDisplaysChanged);
    screen.off('display-removed', this.onDisplaysChanged);
    screen.off('display-metrics-changed', this.onDisplaysChanged);
    clearTimeout(this.rebuildTimer);
    for (const e of this.entries.values()) if (!e.win.isDestroyed()) e.win.destroy();
    this.entries.clear();
  }

  windows(): BrowserWindow[] {
    return [...this.entries.values()].map((e) => e.win).filter((w) => !w.isDestroyed());
  }

  display(displayId: number): DisplayGeometry | undefined {
    return this.entries.get(displayId)?.display;
  }

  /**
   * Expected vs actual drawing area per display (for the debug report). Measured from inside the
   * page: on macOS, getBounds/getContentBounds of a panel window include an invisible title strip
   * that the page never draws into.
   */
  async diagnostics(): Promise<
    { displayId: number; expected: Electron.Rectangle; actual: Electron.Rectangle | null }[]
  > {
    const live = [...this.entries.values()].filter((e) => !e.win.isDestroyed());
    return Promise.all(
      live.map(async (e) => ({
        displayId: e.display.id,
        expected: e.display.bounds,
        actual: await measureDrawingArea(e.win),
      })),
    );
  }

  /**
   * Draw a scene on one display. Re-fits the window to the display first: macOS can move a panel
   * window after it was placed (seen as a 32pt shift on a display with a notch). Resolves once
   * the scene has been sent.
   */
  render(displayId: number, scene: OverlayScene): Promise<boolean> {
    const entry = this.entries.get(displayId);
    if (!entry || entry.win.isDestroyed()) return Promise.resolve(false);
    if (!entry.ready) {
      entry.pending = scene;
      return Promise.resolve(true);
    }
    const { win, display } = entry;
    const done = entry.queue.then(async () => {
      if (!(await fitToDisplay(win, display.bounds))) {
        console.warn(`overlay drawing area could not be fitted on display ${display.id}`);
      }
      if (!win.isDestroyed()) win.webContents.send(OVERLAY_SCENE_CHANNEL, scene);
    });
    entry.queue = done.catch(() => {});
    return done.then(
      () => true,
      () => false,
    );
  }

  async clearAll(): Promise<void> {
    await Promise.all([...this.entries].map(([id, e]) => this.render(id, emptyScene(e.display))));
  }

  /** Recreate overlay windows to match the current display layout (clears drawings). */
  private rebuild(): void {
    for (const e of this.entries.values()) if (!e.win.isDestroyed()) e.win.destroy();
    this.entries.clear();
    for (const display of currentDisplays()) {
      this.entries.set(display.id, this.create(display));
    }
  }

  private create(display: DisplayGeometry): OverlayEntry {
    const { bounds } = display;
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      // macOS: a non-activating panel can float above full-screen apps without stealing focus.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    // Hidden from screen captures unless Qhint's own screenshots can leave it out (macOS).
    win.setContentProtection(!canShowToScreenSharing());
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    // skipTransformProcessType keeps the Dock icon; the panel window type is what lets the overlay
    // float over full-screen apps.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });

    const entry: OverlayEntry = { display, win, ready: false, queue: Promise.resolve() };

    win.webContents.once('did-finish-load', () => {
      // Re-apply bounds once the window exists on its display: on Windows with mixed DPI a
      // window created on another monitor can come out scaled.
      win.setBounds(bounds);
      win.showInactive();
      void fitToDisplay(win, bounds).then((ok) => {
        if (!ok) console.warn(`overlay drawing area could not be fitted on display ${display.id}`);
        entry.ready = true;
        win.webContents.send(OVERLAY_SCENE_CHANNEL, entry.pending ?? emptyScene(display));
        entry.pending = undefined;
      });
    });
    win.webContents.on('render-process-gone', (_e, d) =>
      console.error(`overlay renderer gone: ${d.reason}`),
    );

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/overlay.html`);
    else void win.loadFile(join(__dirname, '../renderer/overlay.html'));
    return entry;
  }
}
