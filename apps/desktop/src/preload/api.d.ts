import type {
  CreateGuideRequest,
  Guide,
  GuideEdit,
  GuideJob,
  GuideLists,
  GuideReport,
  Result,
  UploadProgress,
} from '../shared/guides';
import type { AppInfo, AuthStatus, ProcedureLists } from '../shared/ipc';
import type { OverlayScene } from '../shared/overlay-scene';
import type { PanelAction, PanelView } from '../shared/panel';

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
  /** Development builds: run a hand-written sample guide. */
  runSample(id: string): Promise<{ ok: boolean; error?: string } | null>;
  guides: {
    lists(): Promise<Result<GuideLists>>;
    jobs(): Promise<Result<GuideJob[]>>;
    get(id: string): Promise<Result<Guide>>;
    report(id: string): Promise<Result<GuideReport | null>>;
    update(id: string, edit: GuideEdit): Promise<Result<Guide>>;
    remove(id: string): Promise<Result<true>>;
    submit(id: string): Promise<Result<true>>;
    /** Opens the system file picker; null when cancelled. */
    pickFile(): Promise<Result<string | null>>;
    create(req: CreateGuideRequest): Promise<Result<GuideJob>>;
    /** Start a guide, filling in its variables (e.g. which file to import). */
    run(id: string, values: Record<string, string>): Promise<Result<true>>;
    pathOf(file: File): string;
    onUploadProgress(listener: (p: UploadProgress) => void): () => void;
  };
}

/** Surface exposed to overlay windows as `window.qhintOverlay`. */
export interface QhintOverlayApi {
  onScene(listener: (scene: OverlayScene) => void): void;
}

/** Surface exposed to the step card window as `window.qhintPanel`. */
export interface QhintPanelApi {
  onView(listener: (view: PanelView) => void): void;
  act(action: PanelAction): void;
}

declare global {
  interface Window {
    qhint: QhintApi;
    qhintOverlay: QhintOverlayApi;
    qhintPanel: QhintPanelApi;
  }
}
