/**
 * Global mouse/keyboard watcher (listen-only). Used to notice when the user has done a step, so
 * the guide can move on without a Next button. Nothing is recorded or sent anywhere: events only
 * drive the runner and are dropped immediately. Keys are reduced to "printable / Enter / Tab".
 */
import { screen, systemPreferences } from 'electron';
import type { Point } from '../../shared/geometry';
import type * as UiohookModule from 'uiohook-napi';
import { inputPointToDip } from './coords';

export type KeyKind = 'printable' | 'enter' | 'tab' | 'other';

export interface InputListener {
  onMouseDown(point: Point): void;
  onKey(kind: KeyKind): void;
}

type Uiohook = typeof UiohookModule;

/** macOS needs the Accessibility permission for global input (and for reading window lists). */
export function hasInputPermission(prompt = false): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

export class InputWatcher {
  private hook: Uiohook['uIOhook'] | null = null;
  private keys: Uiohook['UiohookKey'] | null = null;
  private listener: InputListener | null = null;
  private running = false;

  /** Starts watching; returns false (and stays off) without the permission. */
  start(listener: InputListener): boolean {
    this.listener = listener;
    if (this.running) return true;
    if (!hasInputPermission(false)) return false;
    // Loaded lazily: a native module, only needed while a guide runs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi') as Uiohook;
    this.hook = mod.uIOhook;
    this.keys = mod.UiohookKey;
    this.hook.on('mousedown', (e) => {
      const p = inputPointToDip({ x: e.x, y: e.y }, process.platform, (pt) =>
        screen.screenToDipPoint(pt),
      );
      this.listener?.onMouseDown(p);
    });
    this.hook.on('keydown', (e) =>
      this.listener?.onKey(this.kind(e.keycode, e.ctrlKey || e.metaKey || e.altKey)),
    );
    this.hook.start();
    this.running = true;
    return true;
  }

  stop(): void {
    this.listener = null;
    if (!this.running || !this.hook) return;
    this.hook.removeAllListeners();
    this.hook.stop();
    this.running = false;
  }

  private kind(code: number, withModifier: boolean): KeyKind {
    const k = this.keys!;
    if (code === k.Enter || code === k.NumpadEnter) return 'enter';
    if (code === k.Tab) return 'tab';
    if (withModifier) return 'other';
    const modifiers = [
      k.Shift,
      k.ShiftRight,
      k.Ctrl,
      k.CtrlRight,
      k.Alt,
      k.AltRight,
      k.Meta,
      k.MetaRight,
      k.Escape,
    ];
    return modifiers.includes(code as never) ? 'other' : 'printable';
  }
}
