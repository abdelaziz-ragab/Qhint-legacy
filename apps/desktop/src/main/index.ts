import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

// Dev only: QHINT_DEBUG_PORT=9222 exposes Chrome DevTools Protocol for inspecting our windows.
const debugPort = process.env.QHINT_DEBUG_PORT;
if (!app.isPackaged && debugPort && /^\d{2,5}$/.test(debugPort)) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 600,
    show: false,
    title: 'Qhint',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep our own windows out of every screen capture (ours and other apps').
  win.setContentProtection(true);

  win.once('ready-to-show', () => win.show());

  // Content-free diagnostics: codes only, never page content or URLs with queries.
  win.webContents.on('did-fail-load', (_e, code) => console.error(`renderer load failed: ${code}`));
  win.webContents.on('render-process-gone', (_e, d) => console.error(`renderer gone: ${d.reason}`));

  // Never open new Electron windows from content; send https links to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
