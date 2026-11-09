/** The step card (a small clickable window beside the target). */
import type { NoticeKind, Phase } from '../main/runner/machine';

export interface PanelView {
  phase: Phase;
  title: string;
  stepNumber: number;
  totalSteps: number;
  /** Overrides "Step N of M" (e.g. "Before we start" while opening the app). */
  progressLabel?: string;
  instruction: string;
  /** For type and "go to" steps: the text (or address) to type. */
  typeText?: string;
  /** What the user should see once the step is done. */
  expected?: string;
  appName: string;
  notice: { kind: NoticeKind; hint: string } | null;
  canGoBack: boolean;
  /** True when Qhint can see the user's clicks/typing and moves on by itself. */
  autoAdvance: boolean;
  /** The step was just completed: show a brief "Done" before the next one. */
  confirmed?: boolean;
}

export type PanelAction = 'next' | 'back' | 'skip' | 'stuck' | 'retry' | 'stop';

export const PANEL_VIEW_CHANNEL = 'panel:view';
export const PANEL_ACTION_CHANNEL = 'panel:action';
export const PANEL_ACTIONS: readonly PanelAction[] = [
  'next',
  'back',
  'skip',
  'stuck',
  'retry',
  'stop',
];
