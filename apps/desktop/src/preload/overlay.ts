import { contextBridge, ipcRenderer } from 'electron';
import { OVERLAY_SCENE_CHANNEL, type OverlayScene } from '../shared/overlay-scene';
import type { QhintOverlayApi } from './api';

const api: QhintOverlayApi = {
  onScene(listener) {
    ipcRenderer.removeAllListeners(OVERLAY_SCENE_CHANNEL);
    ipcRenderer.on(OVERLAY_SCENE_CHANNEL, (_e, scene: OverlayScene) => listener(scene));
  },
};

contextBridge.exposeInMainWorld('qhintOverlay', api);
