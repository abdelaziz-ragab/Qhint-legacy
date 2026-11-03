import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { OVERLAY_SCENE_CHANNEL, type OverlayScene } from '../../shared/overlay-scene';
import { localWorkArea, type DisplayGeometry } from '../coords/coords';
import { currentDisplays } from '../capture/capture';

interface OverlayEntry {
  display: DisplayGeometry;
  win: BrowserWindow;
  ready: boolean;
  pending?: OverlayScene;
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

  /** Expected vs actual window bounds per display (for the debug report). */
  diagnostics(): { displayId: number; expected: Electron.Rectangle; actual: Electron.Rectangle }[] {
    return [...this.entries.values()]
      .filter((e) => !e.win.isDestroyed())
      .map((e) => ({
        displayId: e.display.id,
        expected: e.display.bounds,
        actual: e.win.getContentBounds(),
      }));
  }

  render(displayId: number, scene: OverlayScene): boolean {
    const entry = this.entries.get(displayId);
    if (!entry || entry.win.isDestroyed()) return false;
    if (entry.ready) entry.win.webContents.send(OVERLAY_SCENE_CHANNEL, scene);
    else entry.pending = scene;
    return true;
  }

  clearAll(): void {
    for (const [id, e] of this.entries) {
      this.render(id, { rings: [], workArea: localWorkArea(e.display) });
    }
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

    win.setContentProtection(true);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const entry: OverlayEntry = { display, win, ready: false };

    win.webContents.once('did-finish-load', () => {
      // Re-apply bounds once the window exists on its display: on Windows with mixed DPI a
      // window created on another monitor can come out scaled.
      win.setBounds(bounds);
      // Compare the drawing area: on macOS the outer frame can include an invisible title strip.
      const actual = win.getContentBounds();
      if (
        actual.x !== bounds.x ||
        actual.y !== bounds.y ||
        actual.width !== bounds.width ||
        actual.height !== bounds.height
      ) {
        console.warn(
          `overlay bounds mismatch on display ${display.id}: ` +
            `expected ${JSON.stringify(bounds)} got ${JSON.stringify(actual)}`,
        );
      }
      win.showInactive();
      entry.ready = true;
      win.webContents.send(
        OVERLAY_SCENE_CHANNEL,
        entry.pending ?? { rings: [], workArea: localWorkArea(display) },
      );
      entry.pending = undefined;
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
