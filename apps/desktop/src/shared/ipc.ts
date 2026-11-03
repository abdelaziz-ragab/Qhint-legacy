/** IPC channel names between the main window renderer and the main process. */
export const IPC = {
  appInfo: 'app:info',
  debugRings: 'debug:rings',
  clearOverlay: 'overlay:clear',
} as const;

export interface AppInfo {
  hotkey: string | null;
  hotkeyIsFallback: boolean;
  /** True only in development builds. */
  debugTools: boolean;
}
