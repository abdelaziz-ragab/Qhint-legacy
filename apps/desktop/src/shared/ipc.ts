/** IPC channel names between the main window renderer and the main process. */
export const IPC = {
  appInfo: 'app:info',
  debugRings: 'debug:rings',
  clearOverlay: 'overlay:clear',
  authStatus: 'auth:status',
  authSignIn: 'auth:sign-in',
  authSignOut: 'auth:sign-out',
  procedures: 'data:procedures',
  runSample: 'guide:run-sample',
  guidesLists: 'guides:lists',
  guidesGet: 'guides:get',
  guidesReport: 'guides:report',
  guidesUpdate: 'guides:update',
  guidesRemove: 'guides:remove',
  guidesSubmit: 'guides:submit',
  guidesJobs: 'guides:jobs',
  guidesPickFile: 'guides:pick-file',
  guidesCreate: 'guides:create',
  guidesRun: 'guides:run',
  /** main -> renderer: upload progress while creating a guide. */
  guidesUploadProgress: 'guides:upload-progress',
} as const;

export interface AppInfo {
  hotkey: string | null;
  hotkeyIsFallback: boolean;
  /** True only in development builds. */
  debugTools: boolean;
}

export type AuthStatus =
  | { signedIn: false; error?: string }
  | { signedIn: true; email: string | null; tenantName: string; role: 'employee' | 'admin' };

export interface ProcedureListItem {
  id: string;
  title: string;
  status: string;
  visibility: string;
}

export interface ProcedureLists {
  company: ProcedureListItem[];
  mine: ProcedureListItem[];
}
