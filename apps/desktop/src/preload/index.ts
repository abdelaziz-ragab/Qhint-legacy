import { contextBridge } from 'electron';
import type { QhintApi } from './api';

const api: QhintApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('qhint', api);
