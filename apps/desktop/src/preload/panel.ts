import { contextBridge, ipcRenderer } from 'electron';
import {
  PANEL_ACTION_CHANNEL,
  PANEL_VIEW_CHANNEL,
  type PanelAction,
  type PanelView,
} from '../shared/panel';
import type { QhintPanelApi } from './api';

const api: QhintPanelApi = {
  onView(listener) {
    ipcRenderer.removeAllListeners(PANEL_VIEW_CHANNEL);
    ipcRenderer.on(PANEL_VIEW_CHANNEL, (_e, view: PanelView) => listener(view));
  },
  act(action: PanelAction) {
    ipcRenderer.send(PANEL_ACTION_CHANNEL, action);
  },
};

contextBridge.exposeInMainWorld('qhintPanel', api);
