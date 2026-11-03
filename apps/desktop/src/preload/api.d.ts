/** Surface exposed to the renderer via contextBridge as `window.qhint`. */
export interface QhintApi {
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

declare global {
  interface Window {
    qhint: QhintApi;
  }
}
