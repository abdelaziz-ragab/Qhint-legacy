/** OS window list (front to back) in global DIP, via get-windows. */
import { app, screen } from 'electron';
import type * as GetWindowsModule from 'get-windows';
import type { WindowInfo } from './presence';

type GetWindows = typeof GetWindowsModule;
let lib: Promise<GetWindows> | null = null;
const load = () => (lib ??= import('get-windows') as Promise<GetWindows>);

export async function listWindows(): Promise<WindowInfo[]> {
  const { openWindows } = await load();
  const wins = await openWindows();
  return wins.map((w) => {
    // macOS reports points (= DIP); Windows reports physical pixels.
    const bounds =
      process.platform === 'win32'
        ? screen.screenToDipRect(null, w.bounds)
        : { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height };
    return {
      id: w.id,
      title: w.title,
      owner: w.owner.name,
      bundleId: 'bundleId' in w.owner ? (w.owner as { bundleId?: string }).bundleId : undefined,
      processId: w.owner.processId,
      bounds,
    };
  });
}

/** Windows that belong to Qhint itself (main window, overlays, step card). */
export function ownWindowFilter(): (w: WindowInfo) => boolean {
  const pids = new Set(app.getAppMetrics().map((m) => m.pid));
  return (w) => pids.has(w.processId);
}
