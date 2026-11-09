import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { UploadProgress } from '../shared/guides';
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
  runSample: (id: string) =>
    ipcRenderer.invoke(IPC.runSample, id) as Promise<{ ok: boolean; error?: string } | null>,
  guides: {
    lists: () => ipcRenderer.invoke(IPC.guidesLists),
    jobs: () => ipcRenderer.invoke(IPC.guidesJobs),
    get: (id) => ipcRenderer.invoke(IPC.guidesGet, id),
    report: (id) => ipcRenderer.invoke(IPC.guidesReport, id),
    update: (id, edit) => ipcRenderer.invoke(IPC.guidesUpdate, id, edit),
    remove: (id) => ipcRenderer.invoke(IPC.guidesRemove, id),
    submit: (id) => ipcRenderer.invoke(IPC.guidesSubmit, id),
    pickFile: () => ipcRenderer.invoke(IPC.guidesPickFile),
    create: (req) => ipcRenderer.invoke(IPC.guidesCreate, req),
    run: (id, values) => ipcRenderer.invoke(IPC.guidesRun, id, values),
    // Path of a file dropped on the window (Electron no longer exposes File.path).
    pathOf: (file) => webUtils.getPathForFile(file),
    onUploadProgress: (listener) => {
      const handler = (_e: unknown, p: UploadProgress) => listener(p);
      ipcRenderer.on(IPC.guidesUploadProgress, handler);
      return () => ipcRenderer.removeListener(IPC.guidesUploadProgress, handler);
    },
  },
};

contextBridge.exposeInMainWorld('qhint', api);
