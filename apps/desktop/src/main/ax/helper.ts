/**
 * Talks to the native accessibility helper (a small separate process, one JSON line per message).
 * macOS (Swift, AX API) and Windows (C#, UI Automation); elsewhere every call answers null and
 * the guide uses screenshots.
 */
import { app, screen } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AxElementsResponse, type AxElement } from './types';

const TIMEOUT_MS = 1500;
const CAPTURE_TIMEOUT_MS = 6000;

function helperPath(): string | null {
  const file =
    process.platform === 'darwin'
      ? 'qhint-ax'
      : process.platform === 'win32'
        ? 'qhint-ax.exe'
        : null;
  if (!file) return null;
  const p = app.isPackaged
    ? join(process.resourcesPath, file)
    : join(app.getAppPath(), 'native/bin', file);
  return existsSync(p) ? p : null;
}

type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

/**
 * Can Qhint's windows be visible to screen sharing? Only when its own screenshots can leave them
 * out: macOS 14+ with the helper. Elsewhere they stay hidden from every capture (Windows: the
 * only way to keep them out of Qhint's screenshots without flicker).
 */
export function canShowToScreenSharing(): boolean {
  const darwinMajor = Number(release().split('.')[0]);
  return process.platform === 'darwin' && darwinMajor >= 23 && helperPath() !== null;
}

export class AxHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly path = helperPath();

  get available(): boolean {
    return this.path !== null;
  }

  /** The app's visible elements (menu bar, open menus, windows); null if unavailable. */
  async elements(pid: number): Promise<AxElement[] | null> {
    const res = await this.request({ cmd: 'elements', pid });
    const parsed = AxElementsResponse.safeParse(res);
    if (!parsed.success) return null;
    // Windows reports physical pixels: convert to DIP (Electron's coordinates), per display.
    if (parsed.data.units !== 'physical' || process.platform !== 'win32')
      return parsed.data.elements;
    return parsed.data.elements.map((e) => {
      const r = screen.screenToDipRect(null, { x: e.x, y: e.y, width: e.w, height: e.h });
      return { ...e, x: r.x, y: r.y, w: r.width, h: r.height };
    });
  }

  /**
   * macOS: a screenshot of one display (JPEG, `size` in pixels) without Qhint's own windows, so
   * the guide can stay visible to screen sharing. Null if unavailable.
   */
  async capture(
    displayId: number,
    size: { width: number; height: number },
  ): Promise<Buffer | null> {
    if (process.platform !== 'darwin') return null;
    const res = (await this.request(
      { cmd: 'capture', display: displayId, ...size, exclude: process.pid },
      CAPTURE_TIMEOUT_MS,
    )) as { ok?: boolean; jpeg?: unknown } | null;
    return res?.ok && typeof res.jpeg === 'string' ? Buffer.from(res.jpeg, 'base64') : null;
  }

  /** Process id of the app in front (menus and dialogs included); null if unavailable. */
  async frontmost(): Promise<number | null> {
    const res = (await this.request({ cmd: 'frontmost' })) as {
      ok?: boolean;
      pid?: unknown;
    } | null;
    return res?.ok && typeof res.pid === 'number' && res.pid > 0 ? res.pid : null;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.proc) return this.proc;
    if (!this.path) return null;
    const proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown };
      } catch {
        return;
      }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id as number);
      p.resolve(msg);
    });
    proc.stderr.resume();
    const reset = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      this.pending.clear();
    };
    proc.on('exit', reset);
    proc.on('error', reset);
    this.proc = proc;
    return proc;
  }

  private request(body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    const proc = this.ensure();
    if (!proc) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      proc.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }
}
