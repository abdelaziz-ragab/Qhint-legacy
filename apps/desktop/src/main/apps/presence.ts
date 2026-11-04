/**
 * Is the step's app on screen? Pure matching over the OS window list (no AI, milliseconds).
 */
import type { StepApp } from '@qhint/schema';
import type { Rect } from '../../shared/geometry';

export interface WindowInfo {
  id: number;
  title: string;
  owner: string;
  bundleId?: string;
  processId: number;
  /** Global DIP. */
  bounds: Rect;
}

export type AppPresence =
  /** A window of the app is the frontmost (non-Qhint) window. */
  | { state: 'front'; window: WindowInfo }
  /** The app has a matching window, but another app is in front. */
  | { state: 'behind'; window: WindowInfo }
  /** The app is running but not showing the right window (e.g. a launcher instead of the editor). */
  | { state: 'partial'; window: WindowInfo }
  | { state: 'missing' };

const STOP_WORDS = new Set(['app', 'the', 'desktop', 'client', 'for', 'and']);

/** Lower-case words of the app name worth matching on, brand first ("libreoffice", "writer"). */
export function appTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

const haystack = (w: WindowInfo) => `${w.owner} ${w.title} ${w.bundleId ?? ''}`.toLowerCase();

/** Same brand (first token), e.g. any LibreOffice window when we want LibreOffice Writer. */
export function matchesBrand(app: StepApp, w: WindowInfo): boolean {
  const brand = appTokens(app.name)[0];
  return !!brand && haystack(w).includes(brand);
}

/**
 * A brand window that is only a launcher (e.g. LibreOffice's Start Center): its title is empty or
 * just the brand/owner name. Document windows have their own titles ("Untitled 1", "Report.odt").
 */
function isLauncher(app: StepApp, w: WindowInfo): boolean {
  const title = w.title.trim().toLowerCase();
  const brand = appTokens(app.name)[0] ?? '';
  return (
    title === '' ||
    title === w.owner.trim().toLowerCase() ||
    title === brand ||
    /start center/.test(title)
  );
}

/**
 * The step's app is showing a usable window. Titles differ by OS (Windows: "Untitled 1 -
 * LibreOffice Writer"; macOS: just "Untitled 1"), so a brand window that isn't a launcher counts.
 */
export function matchesApp(app: StepApp, w: WindowInfo): boolean {
  if (!matchesBrand(app, w)) return false;
  const h = haystack(w);
  if (appTokens(app.name).every((t) => h.includes(t)))
    return !isLauncher(app, w) || appTokens(app.name).length === 1;
  return !isLauncher(app, w);
}

/**
 * `windows` must be in front-to-back order (as the OS reports them). Qhint's own windows are
 * ignored so clicking the step card doesn't count as "another app in front".
 */
export function appPresence(
  app: StepApp,
  windows: WindowInfo[],
  isOwn: (w: WindowInfo) => boolean,
): AppPresence {
  const others = windows.filter((w) => !isOwn(w));
  const usable = others.filter((w) => w.bounds.width > 40 && w.bounds.height > 40);
  const full = usable.find((w) => matchesApp(app, w));
  if (full) {
    // Menus, pop-ups and dialogs are separate windows of the same app: if the frontmost window
    // belongs to the same process, the app is still the one in front.
    const front = others[0];
    return front && front.processId === full.processId
      ? { state: 'front', window: full }
      : { state: 'behind', window: full };
  }
  const brand = usable.find((w) => matchesBrand(app, w));
  return brand ? { state: 'partial', window: brand } : { state: 'missing' };
}
