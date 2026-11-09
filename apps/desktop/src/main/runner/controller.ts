/**
 * Runs a guide: feeds the pure state machine and performs its effects.
 *
 * - Before each step it checks (via the OS window list, no AI) that the step's app is open and in
 *   front. If not, it points the user to it and keeps checking until it is, then continues.
 * - It captures only the display the app is on, locates the target, and draws the pointer/ring.
 * - It watches the user's clicks and typing: clicking the highlighted target (or finishing typing
 *   into it) moves on automatically. Finding the next target proves the last step worked; only
 *   when it can't be found is the last step checked, and the user sent back if it didn't happen.
 */
import type { Procedure, Step, StepApp, VerifyResult } from '@qhint/schema';
import { screen } from 'electron';
import type { Point, Rect } from '../../shared/geometry';
import type { PanelAction, PanelView } from '../../shared/panel';
import type { AppPresence } from '../apps/presence';
import { assessProgress, baselineOf, skippedBefore, type Progress } from '../ax/progress';
import type { AxElement } from '../ax/types';
import type { DisplayCapture } from '../capture/capture';
import {
  frameContains,
  globalToImageBBox,
  globalToLocal,
  localWorkArea,
  type DisplayGeometry,
} from '../coords/coords';
import { clickHits } from '../input/coords';
import type { InputWatcher, KeyKind } from '../input/watcher';
import type { OverlayManager } from '../overlay/manager';
import type { GroundingAttempt } from './grounding';
import {
  initialState,
  reduce,
  type RunnerEffect,
  type RunnerEvent,
  type RunnerState,
} from './machine';
import type { PanelWindow } from './panel-window';
import { placeTarget, pointerStart, type TargetPlacement } from './placement';

/** How often to check whether the app's window moved (when not tracking it live). */
const FOLLOW_MS = 250;
/** Live tracking: how often to re-read the app's state. */
const TRACK_MS = 140;
/** Fewer elements than this means the app doesn't really expose its UI: use screenshots. */
const AX_MIN_ELEMENTS = 8;
/** Moving back a step must hold this long (ignores a menu flickering while it opens). */
const BACK_HOLD_MS = 450;
/** How long the green "done" check shows before the next step is highlighted. */
const CONFIRM_MS = 600;
/** Nothing from the guide on screen for this long: tell the user. */
const LOST_MS = 1500;
/** Another app in front for this many reads: stop tracking and ask the user to switch back. */
const AWAY_READS = 3;
/** Helper unreadable this many times in a row: fall back to screenshots for this guide. */
const AX_FAILURES = 5;
/** Time for the app to react to a click (menu opening, dialog appearing) before we look. */
const SETTLE_MS = 350;
/** Menus/dialogs can take a moment longer to appear: one extra look after this delay. */
const SECOND_LOOK_MS = 450;
/** How many later steps to check when the current target isn't visible (user may be ahead). */
const LOOKAHEAD_STEPS = 2;
/** How often to re-check whether the app has been opened / brought to the front. */
const PRESENCE_POLL_MS = 1000;
/** Typing counts as finished after this long without keys (or on Enter / Tab). */
const TYPING_IDLE_MS = 1500;

export interface GuideDeps {
  overlays: OverlayManager;
  panel: PanelWindow;
  /** Screenshots of the given displays (all if omitted), with Qhint's own windows hidden. */
  capture: (displayIds?: number[]) => Promise<DisplayCapture[]>;
  locate: (
    step: Step,
    captures: DisplayCapture[],
    opts: { escalate: boolean },
  ) => Promise<GroundingAttempt>;
  verify: (step: Step, before: DisplayCapture[], after: DisplayCapture[]) => Promise<VerifyResult>;
  /** The app's UI elements from the OS accessibility API; null when unavailable. */
  elements?: (pid: number) => Promise<AxElement[] | null>;
  /** Process id of the app in front (menus and dialogs included). */
  frontmost?: () => Promise<number | null>;
  /** Where the app is; null when it can't be determined (e.g. missing permission). */
  presence: (app: StepApp) => Promise<AppPresence | null>;
  input: InputWatcher | null;
  reportGap: (step: Step, stepIndex: number) => Promise<void>;
  /** Development builds: one-line debug messages (clicks, decisions). */
  log?: (line: string) => void;
  /** Development builds: record attempts and timings for debugging. */
  onAttempt?: (
    step: Step,
    stepIndex: number,
    attempt: GroundingAttempt,
    timings: Record<string, number>,
  ) => void;
}

const ACTION_EVENTS: Record<PanelAction, RunnerEvent['type']> = {
  next: 'NEXT',
  back: 'BACK',
  skip: 'SKIP',
  stuck: 'STUCK',
  retry: 'RETRY',
  stop: 'STOP',
};

/** What to type for type and "go to" steps (a value the user still has to choose is not shown). */
function typeText(step: Step): string | undefined {
  if ((step.action !== 'type' && step.action !== 'navigate') || step.input === undefined) {
    return undefined;
  }
  return typeof step.input === 'string' ? step.input : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

/** What the card says before the guide can start: the main instruction and a short note. */
function navigationText(
  app: StepApp,
  presence: AppPresence,
): { instruction: string; hint: string } {
  switch (presence.state) {
    case 'missing':
      return { instruction: `Open ${app.name}`, hint: "I'll start as soon as it's open." };
    case 'partial':
      return {
        instruction: `Start ${app.name} from the ${presence.window.owner} window`,
        hint: "I'll continue as soon as it's open.",
      };
    case 'behind':
      return {
        instruction: `Switch back to ${app.name}`,
        hint: "I'll continue when it's in front.",
      };
    default:
      return { instruction: '', hint: '' };
  }
}

/** A step for pointing at whatever opens the app: Dock/taskbar icon, Start menu, launcher button. */
function openAppStep(app: StepApp, presence: AppPresence): Step {
  const description =
    presence.state === 'behind'
      ? `The ${app.name} window, or its icon in the Dock or taskbar`
      : presence.state === 'partial'
        ? `The button or menu item in the open ${presence.window.owner} window that starts ${app.name} (for example a "${app.name.split(' ').at(-1)} Document" button)`
        : `The ${app.name} app icon in the Dock (macOS) or taskbar (Windows)`;
  return {
    id: 'open-app',
    instruction: `Open ${app.name}`,
    app: { name: 'Desktop', kind: 'native' },
    action: 'click',
    target: { description, neighbors: [] },
    optional: false,
  };
}

export class GuideController {
  private state: RunnerState = initialState;
  /** Screenshots behind what's currently highlighted ("before" for checks). */
  private shown: DisplayCapture[] = [];
  /** Where the highlighted target is, for click detection. */
  private target: TargetPlacement | null = null;
  /** Pointer target while asking the user to open the app. */
  private nav: { placement: TargetPlacement; captures: DisplayCapture[] } | null = null;
  private navPoll: NodeJS.Timeout | null = null;
  private navText: { instruction: string; hint: string } | null = null;
  private typed = 0;
  private typingTimer: NodeJS.Timeout | null = null;
  private watching = false;
  /** Live tracking of the app's state (accessibility); null when not running. */
  private tracker: {
    pid: number;
    timer: NodeJS.Timeout;
    busy: boolean;
    key: string;
    lostSince: number | null;
    back: { index: number; since: number } | null;
    finishing: { missed: string[]; since: number } | null;
    away: number;
    failures: number;
  } | null = null;
  private progress: Progress | null = null;
  /** What matched each step when tracking began (elements that were there all along). */
  private baseline: Map<number, string> | null = null;
  /** Showing the "done" check for the step just completed, until this time. */
  private confirmUntil = 0;
  /** Steps finished in ways the app's state can't show (typed into an unreadable field, Skip). */
  private doneByUser = new Set<number>();
  /** Live tracking stopped at a step it can't follow (shown the usual way until done). */
  private checkpoint: number | null = null;
  /** Later steps already visible when the checkpoint began (anything new means it's done). */
  private checkpointLater = new Set<number>();
  private relocateTimer: NodeJS.Timeout | null = null;
  /** The app's window when the current target was found on a screenshot. */
  private locatedWindow: { id: number; bounds: Rect } | null = null;
  /** Keeps a screenshot-found target on the app's window when the window moves. */
  private follow: { timer: NodeJS.Timeout; busy: boolean; resizedTo: Rect | null } | null = null;
  /** The accessibility helper failed during this guide: use screenshots only. */
  private axOff = false;

  constructor(private readonly deps: GuideDeps) {}

  get running(): boolean {
    return this.state.phase !== 'IDLE';
  }

  start(procedure: Procedure): void {
    this.stopTracking();
    this.doneByUser = new Set();
    this.checkpoint = null;
    this.baseline = null;
    this.axOff = false;
    this.watching =
      this.deps.input?.start({
        onMouseDown: (p) => this.onMouseDown(p),
        onKey: (k) => this.onKey(k),
      }) ?? false;
    this.dispatch({ type: 'START', procedure });
  }

  act(action: PanelAction): void {
    if (this.tracker && (action === 'next' || action === 'skip')) {
      this.doneByUser.add(this.state.stepIndex);
    }
    this.dispatch({ type: ACTION_EVENTS[action] } as RunnerEvent);
  }

  private dispatch(event: RunnerEvent): void {
    const { state, effects } = reduce(this.state, event);
    const stepChanged =
      state.stepIndex !== this.state.stepIndex || state.token !== this.state.token;
    this.state = state;
    if (stepChanged || state.phase !== 'HIGHLIGHTING') this.resetTyping();
    if (state.phase !== 'NEEDS_NAVIGATION') this.stopNavigation();
    if (state.phase === 'IDLE' || state.phase === 'COMPLETE' || state.phase === 'NEEDS_NAVIGATION')
      this.stopTracking();
    if (state.phase === 'IDLE') {
      this.deps.input?.stop();
      this.watching = false;
    }
    for (const effect of effects) this.perform(effect);
  }

  private perform(effect: RunnerEffect): void {
    switch (effect.type) {
      case 'locate':
        void this.locate(effect);
        return;
      case 'verify':
        void this.verifyLast(effect);
        return;
      case 'clear':
        this.target = null;
        this.stopFollow();
        void this.deps.overlays.clearAll();
        return;
      case 'show':
        this.render();
        return;
      case 'log_gap': {
        const step = this.state.procedure?.steps[effect.stepIndex];
        if (step) void this.deps.reportGap(step, effect.stepIndex).catch(() => {});
        return;
      }
    }
  }

  // ---------------------------------------------------------------- locate / check

  private async locate(effect: Extract<RunnerEffect, { type: 'locate' }>): Promise<void> {
    const t: Record<string, number> = {};
    const t0 = now();
    const current = () => effect.token === this.state.token;
    try {
      // 1. Is the app there? (OS window list: milliseconds, no AI.)
      let t1 = now();
      const presence = await this.deps.presence(effect.step.app).catch(() => null);
      t.presenceMs = Math.round(now() - t1);
      if (!current()) return;
      if (presence && presence.state !== 'front') {
        this.navText = navigationText(effect.step.app, presence);
        this.dispatch({
          type: 'LOCATED',
          token: effect.token,
          result: { kind: 'none', reason: 'wrong_app', hint: this.navText.hint },
        });
        void this.startNavigation(effect.token, effect.step.app, presence);
        return;
      }
      const displayIds = presence
        ? [screen.getDisplayMatching(presence.window.bounds).id]
        : undefined;
      this.locatedWindow = presence
        ? { id: presence.window.id, bounds: { ...presence.window.bounds } }
        : null;

      // A step that is the user's own choice with no value given (e.g. "the file you want"):
      // nothing to point at; say so and wait for them to do it.
      if (
        this.checkpoint === effect.stepIndex &&
        effect.step.input !== undefined &&
        typeof effect.step.input === 'object'
      ) {
        this.dispatch({
          type: 'USER_CHOICE',
          token: effect.token,
          hint:
            effect.step.action === 'type'
              ? "Type your own text here (whatever fits your task). I'll continue as soon as you're done."
              : effect.step.action === 'navigate'
                ? "Go to the page you need in your browser. I'll continue as soon as you're there."
                : "This one is your choice: pick it in the window. I'll continue as soon as you have.",
        });
        return;
      }

      // 2. Apps that expose their UI (accessibility): follow their state live instead.
      // (A checkpoint step can't be followed that way: find it on the screen instead.)
      if (presence && this.deps.elements && !this.axOff && this.checkpoint !== effect.stepIndex) {
        this.startTracking(presence.window.processId);
        return;
      }
      if (effect.settle) await sleep(SETTLE_MS);

      // 3. Look at the screen, only the app's display.
      t1 = now();
      const captures = await this.deps.capture(displayIds);
      t.captureMs = Math.round(now() - t1);
      if (!current()) return;

      t1 = now();
      const attempt = await this.deps.locate(effect.step, captures, { escalate: effect.escalate });
      t.locateMs = Math.round(now() - t1);
      if (!current()) return;

      let captures2 = captures;
      let attempt2 = attempt;
      // 3a. Just acted and nothing yet? Menus/dialogs can lag: look once more.
      if (
        attempt2.result.kind === 'none' &&
        effect.previous &&
        attempt2.result.reason !== 'wrong_app'
      ) {
        await sleep(SECOND_LOOK_MS);
        if (!current()) return;
        captures2 = await this.deps.capture(displayIds);
        attempt2 = await this.deps.locate(effect.step, captures2, { escalate: effect.escalate });
        t.secondLookMs = Math.round(now() - t1);
        if (!current()) return;
      }

      // 3b. Still not visible: maybe the user is already ahead (did this step on their own).
      if (attempt2.result.kind === 'none' && attempt2.result.reason !== 'wrong_app') {
        const steps = this.state.procedure!.steps;
        for (
          let i = effect.stepIndex + 1;
          i <= effect.stepIndex + LOOKAHEAD_STEPS && i < steps.length;
          i++
        ) {
          const later = steps[i]!;
          if (!later.target || later.action === 'manual' || later.action === 'wait') break;
          const ahead = await this.deps.locate(later, captures2, { escalate: false });
          if (!current()) return;
          if (ahead.result.kind === 'found') {
            this.deps.log?.(`already ahead: step ${effect.stepIndex + 1} -> step ${i + 1}`);
            this.shown = captures2;
            this.dispatch({
              type: 'AHEAD',
              token: effect.token,
              stepIndex: i,
              result: ahead.result,
            });
            return;
          }
        }
      }
      const finalCaptures = captures2;
      // Our own window check says the app is in front: a "wrong app" answer from the model is a
      // naming mismatch (e.g. Writer open, guide written for Calc), not a reason to send the user
      // elsewhere. Treat it as "not visible yet".
      const finalAttempt: GroundingAttempt =
        presence?.state === 'front' &&
        attempt2.result.kind === 'none' &&
        attempt2.result.reason === 'wrong_app'
          ? { ...attempt2, result: { kind: 'none', reason: 'not_visible', hint: '' } }
          : attempt2;

      // 3c. Nothing found right after the user acted: did their last step actually happen?
      if (finalAttempt.result.kind === 'none' && effect.previous && this.shown.length > 0) {
        t1 = now();
        const check = await this.deps
          .verify(effect.previous.step, this.shown, captures)
          .catch(() => null);
        t.verifyMs = Math.round(now() - t1);
        if (!current()) return;
        if (check?.status === 'not_done') {
          this.dispatch({
            type: 'PREVIOUS_NOT_DONE',
            token: effect.token,
            stepIndex: effect.previous.stepIndex,
            explanation: check.explanation,
          });
          return;
        }
        if (check?.status === 'off_track') {
          this.dispatch({ type: 'OFF_TRACK', token: effect.token, explanation: check.explanation });
          return;
        }
      }

      t.totalMs = Math.round(now() - t0);
      this.deps.onAttempt?.(effect.step, effect.stepIndex, finalAttempt, t);
      if (finalAttempt.result.kind === 'found') this.shown = finalCaptures;
      this.dispatch({ type: 'LOCATED', token: effect.token, result: finalAttempt.result });
    } catch {
      if (current()) this.dispatch({ type: 'LOCATE_FAILED', token: effect.token });
    }
  }

  // ---------------------------------------------------------------- live tracking

  private startTracking(pid: number): void {
    if (this.tracker?.pid === pid) return;
    this.stopTracking();
    this.tracker = {
      pid,
      timer: setInterval(() => void this.track(), TRACK_MS),
      busy: false,
      key: '',
      lostSince: null,
      back: null,
      finishing: null,
      away: 0,
      failures: 0,
    };
    void this.track();
  }

  private stopTracking(): void {
    if (this.tracker) clearInterval(this.tracker.timer);
    this.tracker = null;
    this.progress = null;
    this.confirmUntil = 0;
  }

  /** One read of the app's state: work out the current step and highlight it if it changed. */
  private async track(): Promise<void> {
    const tr = this.tracker;
    if (!tr || tr.busy) return;
    tr.busy = true;
    try {
      const { procedure, phase } = this.state;
      if (!procedure || phase === 'IDLE' || phase === 'COMPLETE') return this.stopTracking();

      // Still in the app? (Qhint's own card counts as in.)
      const front = (await this.deps.frontmost?.().catch(() => null)) ?? null;
      if (this.tracker !== tr) return;
      if (front !== null && front !== tr.pid && front !== process.pid) {
        if (++tr.away < AWAY_READS) return;
        // Double-check with the window list: tools without windows (e.g. the screenshot tool)
        // can be "in front" while the app is still what the user sees.
        tr.away = 0;
        const app = procedure.steps[this.state.stepIndex]!.app;
        const presence = await this.deps.presence(app).catch(() => null);
        if (this.tracker !== tr) return;
        if (presence && presence.state !== 'front') {
          this.deps.log?.(`left the app (now ${presence.state})`);
          this.stopTracking();
          this.dispatch({ type: 'RETRY' }); // guides the user back
          return;
        }
      } else {
        tr.away = 0;
      }

      const elements = await this.deps.elements!(tr.pid).catch(() => null);
      if (this.tracker !== tr) return;
      if (!elements || elements.length < AX_MIN_ELEMENTS) {
        if (++tr.failures >= AX_FAILURES) {
          this.deps.log?.('elements unreadable: switching to screenshots');
          this.axOff = true;
          this.stopTracking();
          this.dispatch({ type: 'RETRY' });
        }
        return;
      }
      tr.failures = 0;

      const steps = procedure.steps;
      this.baseline ??= baselineOf(steps, elements);
      const p = assessProgress(steps, elements, {
        doneByUser: this.doneByUser,
        baseline: this.baseline,
        shown: this.state.stepIndex,
      });
      this.progress = p;
      const last = steps.length - 1;

      // The user clicked the last step's target: done once it goes away (e.g. the dialog closed).
      if (tr.finishing) {
        if (!p.steps[last]!.match) {
          const { missed } = tr.finishing;
          this.deps.log?.(`finished${missed.length ? `, left undone: ${missed.join(' | ')}` : ''}`);
          this.stopTracking();
          this.dispatch({ type: 'FINISHED', missed });
          return;
        }
        if (now() - tr.finishing.since < 3000) return;
        tr.finishing = null;
      }

      // A step the app's state can't confirm comes first: show it and wait for the user.
      if (p.checkpoint && p.current !== null) {
        tr.lostSince = null;
        const cp = p.current;
        const laterVisible = new Set(p.steps.flatMap((s, i) => (i > cp && s.match ? [i] : [])));
        if (this.checkpoint !== cp) {
          this.checkpoint = cp;
          this.checkpointLater = laterVisible;
          tr.key = '';
          this.deps.log?.(`checkpoint: step ${cp + 1}`);
          this.dispatch({ type: 'GOTO', stepIndex: cp });
          return;
        }
        // Something from a later step newly appeared (e.g. the dialog's Open button became
        // clickable once a file was picked): the checkpoint step has been done.
        const appeared = [...laterVisible].find((i) => !this.checkpointLater.has(i));
        if (appeared !== undefined && steps[cp]!.action !== 'manual') {
          this.deps.log?.(`checkpoint done: step ${cp + 1} (step ${appeared + 1} appeared)`);
          this.doneByUser.add(cp);
        }
        return;
      }
      this.checkpoint = null;

      if (p.current === null) {
        tr.lostSince ??= now();
        if (now() - tr.lostSince > LOST_MS && this.state.phase !== 'TEXT_ONLY') {
          this.deps.log?.('nothing from the guide on screen');
          tr.key = '';
          this.dispatch({
            type: 'LOST',
            hint: 'Close anything that popped up, or go back to where you were. I’ll pick up automatically.',
          });
        }
        return;
      }
      tr.lostSince = null;

      const index = p.current;
      const rect = p.steps[index]!.match!.rect;
      const highlighting = this.state.phase === 'HIGHLIGHTING';
      const backwards = highlighting && index < this.state.stepIndex;
      if (backwards) {
        if (tr.back?.index !== index) tr.back = { index, since: now() };
        if (now() - tr.back.since < BACK_HOLD_MS) return;
      }
      tr.back = null;

      // A confirmation was showing but the user is no longer ahead (e.g. the menu closed again).
      if (this.confirmUntil && !(highlighting && index > this.state.stepIndex)) {
        this.confirmUntil = 0;
        this.render();
      }

      const key = `${index}:${[rect.x, rect.y, rect.width, rect.height].map(Math.round).join(',')}`;
      if (key === tr.key && highlighting && this.state.stepIndex === index) return;
      // Same step, it just moved (e.g. the window was dragged): move the pointer with it.
      if (highlighting && this.state.stepIndex === index && tr.key.startsWith(`${index}:`)) {
        if (this.moveTarget(rect)) {
          tr.key = key;
          return;
        }
      }

      // Moving on: first show a short green check on what the user just did.
      if (highlighting && index > this.state.stepIndex && this.target) {
        if (this.confirmUntil === 0) {
          this.confirmUntil = now() + CONFIRM_MS;
          this.showConfirmation();
          return;
        }
        if (now() < this.confirmUntil) return;
      }
      this.confirmUntil = 0;

      const result = await this.foundAt(steps[index]!, index, rect);
      if (this.tracker !== tr || !result) return;
      tr.key = key;
      this.deps.log?.(`step ${index + 1}${backwards ? ' (went back)' : ''}`);
      this.dispatch({
        type: 'SYNC',
        stepIndex: index,
        result,
        ...(backwards ? { notice: { kind: 'went_back' as const, hint: '' } } : {}),
      });
    } finally {
      tr.busy = false;
    }
  }

  private showConfirmation(): void {
    if (!this.target) return;
    this.drawGuide(this.target, this.shown, 'done');
    const view = this.view();
    if (view) this.deps.panel.show({ ...view, confirmed: true }, this.target.global);
  }

  /** Turn an element's global rect into a "found" result on a fresh screenshot of its display. */
  private async foundAt(
    step: Step,
    stepIndex: number,
    rect: Rect,
  ): Promise<Extract<GroundingAttempt['result'], { kind: 'found' }> | null> {
    const c = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const display = screen.getDisplayNearestPoint(c);
    // Kept as the "before" picture in case a screenshot check is needed later.
    const captures = await this.deps.capture([display.id]);
    const frame = captures.find((f) => frameContains(f, c));
    if (!frame) return null;
    const result = {
      kind: 'found' as const,
      screen: frame.label,
      bbox: [...globalToImageBBox(rect, frame)] as [number, number, number, number],
      confidence: 'high' as const,
      label: step.target?.text ?? '',
    };
    this.shown = captures;
    this.deps.onAttempt?.(step, stepIndex, { result, captures, source: 'elements' }, {});
    return result;
  }

  private async verifyLast(effect: Extract<RunnerEffect, { type: 'verify' }>): Promise<void> {
    try {
      await sleep(SETTLE_MS);
      const displayIds = [...new Set(this.shown.map((c) => c.display.id))];
      const after = await this.deps.capture(displayIds.length ? displayIds : undefined);
      const r = await this.deps.verify(effect.step, this.shown, after);
      this.dispatch({
        type: 'VERIFIED',
        token: effect.token,
        status: r.status,
        explanation: r.explanation,
      });
    } catch {
      // If the check itself fails, trust the user's click rather than leave them stuck.
      this.dispatch({ type: 'VERIFIED', token: effect.token, status: 'done', explanation: '' });
    }
  }

  // ---------------------------------------------------------------- "open the app" guidance

  private async startNavigation(token: number, app: StepApp, presence: AppPresence): Promise<void> {
    // Keep the card's text (set just before); only replace the previous check and pointer.
    if (this.navPoll) clearInterval(this.navPoll);
    this.nav = null;
    // Keep checking; continue as soon as the app is in front, and update the instruction (and
    // pointer) as soon as anything changes, e.g. LibreOffice opened but Writer not yet.
    this.navPoll = setInterval(() => {
      void this.deps.presence(app).then((p) => {
        if (!p || this.state.phase !== 'NEEDS_NAVIGATION' || this.state.token !== token) return;
        if (p.state === 'front' || p.state !== presence.state) {
          this.deps.log?.(`app is now ${p.state}`);
          this.dispatch({ type: 'RETRY' });
        }
      });
    }, PRESENCE_POLL_MS);

    // Meanwhile, point at whatever opens it (Dock/taskbar icon, launcher button).
    try {
      const captures = await this.deps.capture();
      const attempt = await this.deps.locate(openAppStep(app, presence), captures, {
        escalate: false,
      });
      if (this.state.phase !== 'NEEDS_NAVIGATION' || this.state.token !== token) return;
      if (attempt.result.kind === 'found') {
        const placement = placeTarget(attempt.result, captures);
        if (placement) {
          this.nav = { placement, captures };
          this.render();
        }
      }
    } catch (err) {
      // The text instruction is enough; note why the pointer is missing.
      this.deps.log?.(`open-app pointer failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  private stopNavigation(): void {
    if (this.navPoll) clearInterval(this.navPoll);
    this.navPoll = null;
    this.nav = null;
    this.navText = null;
  }

  // ---------------------------------------------------------------- watching the user

  private onMouseDown(p: Point): void {
    if (this.tracker && this.checkpoint === this.state.stepIndex && this.state.procedure) {
      this.onCheckpointClick(p);
      return;
    }
    if (this.state.phase !== 'HIGHLIGHTING' || !this.target) return;
    const panel = this.deps.panel.window();
    if (panel?.isVisible() && clickHits(p, panel.getBounds(), 0)) return; // handled by the card
    const step = this.state.procedure!.steps[this.state.stepIndex]!;
    const onTarget = clickHits(p, this.target.global);
    this.deps.log?.(
      `click at ${Math.round(p.x)},${Math.round(p.y)} | target ${JSON.stringify(this.target.global)} | ${onTarget ? 'on target' : 'elsewhere'}`,
    );

    // Live tracking: the app's state decides; clicks only matter for finishing the last step.
    if (this.tracker) {
      const steps = this.state.procedure!.steps;
      const index = this.state.stepIndex;
      if (step.action === 'type' && !onTarget && this.typed > 0) this.typedInto(index);
      // A checkpoint is done when its control is clicked.
      if (this.checkpoint === index && onTarget && step.action !== 'type') {
        this.deps.log?.(`checkpoint done: step ${index + 1}`);
        this.doneByUser.add(index);
      }
      if (onTarget && index === steps.length - 1 && step.action !== 'type') {
        const missed = this.progress ? skippedBefore(this.progress, index, steps) : [];
        this.tracker.finishing = { missed, since: now() };
      }
      return;
    }

    if (step.action === 'type') {
      if (onTarget) return; // focusing the field; wait for typing
      if (this.typed > 0)
        this.dispatch({ type: 'ACTED' }); // typed, then moved on
      else this.dispatch({ type: 'WRONG_CLICK' });
      return;
    }
    this.dispatch({ type: onTarget ? 'ACTED' : 'WRONG_CLICK' });
  }

  /**
   * A click while stopped at a checkpoint: on its target = done; on a later step's control =
   * the user moved on (did it, or skipped a check), and if that's the last step, it finishes.
   * Otherwise look again shortly (the click may have revealed the target, e.g. opened a folder).
   */
  private onCheckpointClick(p: Point): void {
    const panel = this.deps.panel.window();
    if (panel?.isVisible() && clickHits(p, panel.getBounds(), 0)) return; // handled by the card
    const steps = this.state.procedure!.steps;
    const index = this.state.stepIndex;
    const step = steps[index]!;
    if (this.target && clickHits(p, this.target.global) && step.action !== 'type') {
      this.deps.log?.(`checkpoint done: step ${index + 1} (clicked)`);
      this.doneByUser.add(index);
      return;
    }
    const later = this.progress?.steps.findIndex(
      (s, i) => i > index && !!s.match && clickHits(p, s.match.rect),
    );
    if (later !== undefined && later > index) {
      this.deps.log?.(`checkpoint passed: step ${index + 1} (clicked step ${later + 1})`);
      this.doneByUser.add(index);
      const laterStep = steps[later]!;
      if (later === steps.length - 1 && laterStep.action !== 'type' && this.tracker) {
        const missed = this.progress ? skippedBefore(this.progress, later, steps) : [];
        this.tracker.finishing = { missed, since: now() };
      }
      return;
    }
    if (this.state.phase === 'TEXT_ONLY' && this.state.notice?.kind === 'not_found') {
      if (this.relocateTimer) clearTimeout(this.relocateTimer);
      const token = this.state.token;
      this.relocateTimer = setTimeout(() => {
        if (this.state.token === token && this.checkpoint === index)
          this.dispatch({ type: 'RETRY' });
      }, 700);
    }
  }

  private onKey(kind: KeyKind): void {
    if (this.state.phase !== 'HIGHLIGHTING') return;
    const index = this.state.stepIndex;
    const step = this.state.procedure!.steps[index]!;
    if (step.action !== 'type') return;
    const finish = () => (this.tracker ? this.typedInto(index) : this.dispatch({ type: 'ACTED' }));
    if (kind === 'enter' || kind === 'tab') {
      if (this.typed > 0) finish();
      return;
    }
    if (kind !== 'printable') return;
    this.typed++;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    const token = this.state.token;
    this.typingTimer = setTimeout(() => {
      if (this.state.phase === 'HIGHLIGHTING' && this.state.token === token) finish();
    }, TYPING_IDLE_MS);
  }

  /**
   * Live tracking, type steps: the field's value normally shows the step is done. Only when the
   * field's value can't be read does finishing typing count instead.
   */
  private typedInto(index: number): void {
    const m = this.progress?.steps[index]?.match;
    if (this.checkpoint === index || (m && m.element.value === undefined)) {
      this.doneByUser.add(index);
    }
  }

  private resetTyping(): void {
    this.typed = 0;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
  }

  // ---------------------------------------------------------------- following the window

  /** Move the highlighted target to a new global rect. False if it changed display. */
  private moveTarget(global: Rect): boolean {
    const t = this.target;
    const step = this.state.procedure?.steps[this.state.stepIndex];
    if (!t || !step) return false;
    const center = { x: global.x + global.width / 2, y: global.y + global.height / 2 };
    const display: DisplayGeometry = screen.getDisplayNearestPoint(center);
    if (display.id !== t.displayId) return false;
    this.target = { displayId: t.displayId, global, local: globalToLocal(global, display) };
    this.drawGuide(
      this.target,
      this.shown,
      step.action === 'type' || step.action === 'navigate' ? 'type' : 'click',
      typeText(step),
    );
    const view = this.view();
    if (view) this.deps.panel.show(view, global);
    return true;
  }

  /**
   * A target found on a screenshot stays put on screen; keep it on the app's window instead.
   * Moved: shift it by the same amount. Resized (or moved to another display): find it again
   * once the window stops changing. (Live tracking follows the window by itself.)
   */
  private startFollow(): void {
    this.stopFollow();
    const tracked = this.tracker && this.checkpoint === null;
    if (tracked || !this.locatedWindow) return;
    const follow = {
      busy: false,
      resizedTo: null as Rect | null,
      timer: setInterval(() => {
        if (follow.busy) return;
        follow.busy = true;
        void this.followTick(follow).finally(() => (follow.busy = false));
      }, FOLLOW_MS),
    };
    this.follow = follow;
  }

  private stopFollow(): void {
    if (this.follow) clearInterval(this.follow.timer);
    this.follow = null;
  }

  private async followTick(f: NonNullable<typeof this.follow>): Promise<void> {
    const step = this.state.procedure?.steps[this.state.stepIndex];
    const was = this.locatedWindow;
    if (!step || !was || this.state.phase !== 'HIGHLIGHTING') return this.stopFollow();
    const p = await this.deps.presence(step.app).catch(() => null);
    if (this.follow !== f || !p || p.state === 'missing' || p.window.id !== was.id) return;
    const now = p.window.bounds;
    const sameSize = now.width === was.bounds.width && now.height === was.bounds.height;
    const dx = now.x - was.bounds.x;
    const dy = now.y - was.bounds.y;
    if (sameSize && dx === 0 && dy === 0) {
      f.resizedTo = null;
      return;
    }
    if (sameSize && this.target) {
      const g = this.target.global;
      if (this.moveTarget({ ...g, x: g.x + dx, y: g.y + dy })) {
        this.locatedWindow = { id: was.id, bounds: { ...now } };
        return;
      }
    }
    // Resized or on another display: the layout may have changed. Look again once it settles.
    const settled =
      f.resizedTo &&
      f.resizedTo.x === now.x &&
      f.resizedTo.y === now.y &&
      f.resizedTo.width === now.width &&
      f.resizedTo.height === now.height;
    if (!settled) {
      f.resizedTo = { ...now };
      return;
    }
    this.deps.log?.('window resized: finding the target again');
    this.stopFollow();
    this.dispatch({ type: 'RETRY' });
  }

  // ---------------------------------------------------------------- drawing

  private view(): PanelView | null {
    const { procedure, stepIndex, phase, notice } = this.state;
    if (!procedure) return null;
    const step = procedure.steps[stepIndex]!;
    const navigating = phase === 'NEEDS_NAVIGATION' && this.navText;
    return {
      phase,
      title: procedure.title,
      stepNumber: stepIndex + 1,
      totalSteps: procedure.steps.length,
      progressLabel: navigating ? 'Before we start' : undefined,
      instruction: navigating ? this.navText!.instruction : step.instruction,
      typeText: navigating ? undefined : typeText(step),
      expected: navigating ? undefined : step.expectedAfter,
      appName: step.app.name,
      notice,
      canGoBack: stepIndex > 0,
      autoAdvance: this.watching,
    };
  }

  private drawGuide(
    placement: TargetPlacement,
    captures: DisplayCapture[],
    kind: 'click' | 'type' | 'done',
    text?: string,
  ): void {
    const display =
      captures.find((c) => c.display.id === placement.displayId)?.display ??
      screen.getAllDisplays().find((d) => d.id === placement.displayId);
    if (!display) return;
    void this.deps.overlays.render(display.id, {
      rings: [],
      workArea: localWorkArea(display),
      origin: display.bounds,
      guide: {
        kind,
        rect: placement.local,
        text,
        pointerFrom: pointerStart(screen.getCursorScreenPoint(), display.bounds, placement.local),
        // Same step, same key: a moved target glides over instead of starting again.
        key: String(this.state.token),
      },
    });
  }

  private render(): void {
    const { phase, found, procedure, stepIndex } = this.state;
    const view = this.view();
    if (phase === 'IDLE' || !view || !procedure) {
      this.deps.panel.hide();
      void this.deps.overlays.clearAll();
      return;
    }
    if (phase === 'HIGHLIGHTING' && found) {
      const placement = placeTarget(found, this.shown);
      if (placement) {
        const step = procedure.steps[stepIndex]!;
        this.target = placement;
        this.drawGuide(
          placement,
          this.shown,
          step.action === 'type' || step.action === 'navigate' ? 'type' : 'click',
          typeText(step),
        );
        this.deps.panel.show(view, placement.global);
        this.startFollow();
        return;
      }
    }
    if (phase === 'NEEDS_NAVIGATION' && this.nav) {
      this.drawGuide(this.nav.placement, this.nav.captures, 'click');
      this.deps.panel.show(view, this.nav.placement.global as Rect);
      return;
    }
    this.deps.panel.show(view, null);
  }
}
