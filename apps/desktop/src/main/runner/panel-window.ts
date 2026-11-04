/**
 * The step card: a small always-on-top window beside the target with the instruction and the
 * Back / Skip / I'm stuck / Next buttons. It is a separate window because the overlay must stay
 * click-through. On macOS it's a non-activating panel, so clicking it doesn't steal focus.
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import type { Rect } from '../../shared/geometry';
import {
  PANEL_ACTION_CHANNEL,
  PANEL_ACTIONS,
  PANEL_VIEW_CHANNEL,
  type PanelAction,
  type PanelView,
} from '../../shared/panel';
import { placeCard } from '../../shared/placement';

export const PANEL_SIZE = { width: 380, height: 196 };
const MARGIN = 24;

export class PanelWindow {
  private win: BrowserWindow | undefined;
  private ready = false;
  private pending: PanelView | null = null;
  private handler: (action: PanelAction) => void = () => {};

  constructor() {
    ipcMain.on(PANEL_ACTION_CHANNEL, (e, action: unknown) => {
      if (!this.win || e.sender.id !== this.win.webContents.id) return;
      if (typeof action === 'string' && (PANEL_ACTIONS as readonly string[]).includes(action)) {
        this.handler(action as PanelAction);
      }
    });
  }

  onAction(handler: (action: PanelAction) => void): void {
    this.handler = handler;
  }

  window(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined;
  }

  /** Show the card beside `anchor` (global DIP), or in the corner of the active display. */
  show(view: PanelView, anchor: Rect | null): void {
    const win = this.window() ?? this.create();
    const cursor = screen.getCursorScreenPoint();
    const display = anchor
      ? screen.getDisplayMatching(anchor)
      : screen.getDisplayNearestPoint(cursor);
    const area = display.workArea;
    const rect = anchor
      ? placeCard(anchor, PANEL_SIZE, area, 18).rect
      : {
          // No target to sit beside: bottom-centre of the screen the user is working on.
          x: area.x + (area.width - PANEL_SIZE.width) / 2,
          y: area.y + area.height - PANEL_SIZE.height - MARGIN,
          ...PANEL_SIZE,
        };
    win.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: PANEL_SIZE.width,
      height: PANEL_SIZE.height,
    });
    if (this.ready) win.webContents.send(PANEL_VIEW_CHANNEL, view);
    else this.pending = view;
    if (!win.isVisible()) win.showInactive();
  }

  hide(): void {
    this.window()?.hide();
  }

  dispose(): void {
    this.window()?.destroy();
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      ...PANEL_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/panel.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setContentProtection(true);
    // Above the overlay windows (same level, one step higher).
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.pending) win.webContents.send(PANEL_VIEW_CHANNEL, this.pending);
      this.pending = null;
    });
    win.on('closed', () => {
      this.win = undefined;
      this.ready = false;
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/panel.html`);
    else void win.loadFile(join(__dirname, '../renderer/panel.html'));
    this.win = win;
    return win;
  }
}
