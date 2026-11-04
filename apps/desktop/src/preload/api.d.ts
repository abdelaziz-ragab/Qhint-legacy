import type { AppInfo, AuthStatus, ProcedureLists } from '../shared/ipc';
import type { OverlayScene } from '../shared/overlay-scene';

/** Surface exposed to the main window renderer as `window.qhint`. */
export interface QhintApi {
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  appInfo(): Promise<AppInfo | null>;
  /** Dev/debug: capture, draw test rings, return a text summary. */
  debugRings(): Promise<string | null>;
  clearOverlay(): Promise<void>;
  /** Sign-in happens in the system browser; tokens never reach the renderer. */
  auth: {
    status(): Promise<AuthStatus | null>;
    signIn(): Promise<AuthStatus | null>;
    signOut(): Promise<AuthStatus | null>;
  };
  procedures(): Promise<ProcedureLists | null>;
}

/** Surface exposed to overlay windows as `window.qhintOverlay`. */
export interface QhintOverlayApi {
  onScene(listener: (scene: OverlayScene) => void): void;
}

declare global {
  interface Window {
    qhint: QhintApi;
    qhintOverlay: QhintOverlayApi;
  }
}
