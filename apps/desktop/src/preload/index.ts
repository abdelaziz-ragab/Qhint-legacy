import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppInfo } from '../shared/ipc';
import type { QhintApi } from './api';

const api: QhintApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
  },
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo | null>,
  debugRings: () => ipcRenderer.invoke(IPC.debugRings) as Promise<string | null>,
  clearOverlay: () => ipcRenderer.invoke(IPC.clearOverlay) as Promise<void>,
};

contextBridge.exposeInMainWorld('qhint', api);
