/**
 * Talks to the native accessibility helper (a small separate process, one JSON line per message).
 * macOS only for now; elsewhere every call answers null and the guide uses screenshots.
 */
import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AxElementsResponse, type AxElement } from './types';

const TIMEOUT_MS = 1500;

function helperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const p = app.isPackaged
    ? join(process.resourcesPath, 'qhint-ax')
    : join(app.getAppPath(), 'native/bin/qhint-ax');
  return existsSync(p) ? p : null;
}

type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

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
    return parsed.success ? parsed.data.elements : null;
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
    const proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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

  private request(body: Record<string, unknown>): Promise<unknown> {
    const proc = this.ensure();
    if (!proc) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      proc.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }
}
