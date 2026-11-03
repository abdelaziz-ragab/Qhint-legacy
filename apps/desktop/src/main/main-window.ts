import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { appIcon } from './icons';

/** The small Qhint panel (Ask / Library / Create later). Hidden instead of closed. */
export class MainWindow {
  private win: BrowserWindow | undefined;
  private quitting = false;

  constructor() {
    app.on('before-quit', () => {
      this.quitting = true;
    });
  }

  get window(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined;
  }

  show(): void {
    const win = this.window ?? this.create();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  toggle(): void {
    const win = this.window;
    if (win && win.isVisible() && win.isFocused()) win.hide();
    else this.show();
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 420,
      height: 600,
      show: false,
      title: 'Qhint',
      // Windows taskbar / window icon (macOS uses the Dock icon).
      ...(process.platform === 'darwin' ? {} : { icon: appIcon() }),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Keep our own windows out of screen captures.
    win.setContentProtection(true);

    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
      }
    });

    // Content-free diagnostics: codes only.
    win.webContents.on('did-fail-load', (_e, code) =>
      console.error(`renderer load failed: ${code}`),
    );
    win.webContents.on('render-process-gone', (_e, d) =>
      console.error(`renderer gone: ${d.reason}`),
    );

    // Never open new Electron windows from content; send https links to the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
    else void win.loadFile(join(__dirname, '../renderer/index.html'));

    this.win = win;
    return win;
  }
}
