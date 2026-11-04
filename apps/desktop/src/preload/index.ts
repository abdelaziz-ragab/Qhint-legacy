import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppInfo, type AuthStatus, type ProcedureLists } from '../shared/ipc';
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
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus) as Promise<AuthStatus | null>,
    signIn: () => ipcRenderer.invoke(IPC.authSignIn) as Promise<AuthStatus | null>,
    signOut: () => ipcRenderer.invoke(IPC.authSignOut) as Promise<AuthStatus | null>,
  },
  procedures: () => ipcRenderer.invoke(IPC.procedures) as Promise<ProcedureLists | null>,
};

contextBridge.exposeInMainWorld('qhint', api);
