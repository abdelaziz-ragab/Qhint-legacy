/**
 * The guidance runner as a pure state machine: (state, event) -> (state, effects).
 * No timers, screens or network here; the controller performs the effects and feeds results
 * back as events. Every request carries a token so late answers for an old step are ignored.
 *
 * Flow: the user does the highlighted step (ACTED, detected from their click or typing) and the
 * runner moves straight to the next step. Finding the next step's target is the proof the last
 * step worked; only when it can't be found does the controller check the previous step and, if
 * it didn't happen, send the user back (PREVIOUS_NOT_DONE). The last step is checked explicitly
 * (VERIFYING) before the guide reports success.
 */
import type { LocateResult, Procedure, Step } from '@qhint/schema';

export type Phase =
  | 'IDLE'
  | 'LOCATING'
  | 'HIGHLIGHTING'
  | 'NEEDS_NAVIGATION'
  | 'TEXT_ONLY'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'COMPLETE';

export type StepOutcome = 'done' | 'skipped';

export type NoticeKind =
  | 'not_found'
  | 'wrong_app'
  | 'no_target'
  | 'error'
  | 'stuck'
  | 'wrong_click'
  | 'missed'
  | 'off_track'
  /** Live tracking moved back a step (e.g. a menu or dialog closed before the step was done). */
  | 'went_back';

export interface RunnerState {
  phase: Phase;
  procedure: Procedure | null;
  stepIndex: number;
  /** Increments with every request; results carrying another token are stale. */
  token: number;
  /** Locate attempts for the current step (resets when the step changes). */
  attempts: number;
  found: Extract<LocateResult, { kind: 'found' }> | null;
  /** What to tell the user alongside the step. */
  notice: { kind: NoticeKind; hint: string } | null;
  outcomes: StepOutcome[];
}

export type RunnerEvent =
  | { type: 'START'; procedure: Procedure }
  | { type: 'LOCATED'; token: number; result: LocateResult }
  | { type: 'LOCATE_FAILED'; token: number }
  /** The user did the highlighted step (clicked the target / finished typing). */
  | { type: 'ACTED' }
  /** The current target isn't visible but a later step's is: the user is already ahead. */
  | {
      type: 'AHEAD';
      token: number;
      stepIndex: number;
      result: Extract<LocateResult, { kind: 'found' }>;
    }
  /**
   * Live tracking (accessibility): the app's state says the user is on this step, with this
   * target. Can move forwards or backwards.
   */
  | {
      type: 'SYNC';
      stepIndex: number;
      result: Extract<LocateResult, { kind: 'found' }>;
      notice?: RunnerState['notice'];
    }
  /** Live tracking: go to this step and show it the usual way (it can't be followed live). */
  | { type: 'GOTO'; stepIndex: number }
  /** The step is the user's own choice (e.g. which file): show it as text and wait. */
  | { type: 'USER_CHOICE'; token: number; hint: string }
  /** Live tracking: nothing from the guide is on screen right now. */
  | { type: 'LOST'; hint: string }
  /** Live tracking: the last step was done. `missed` lists steps left undone on the way. */
  | { type: 'FINISHED'; missed: string[] }
  /** The user clicked somewhere other than the highlighted target. */
  | { type: 'WRONG_CLICK' }
  /** The next target wasn't found and the check says the previous step didn't happen. */
  | { type: 'PREVIOUS_NOT_DONE'; token: number; stepIndex: number; explanation: string }
  | { type: 'OFF_TRACK'; token: number; explanation: string }
  /** Result of checking the last step. */
  | {
      type: 'VERIFIED';
      token: number;
      status: 'done' | 'not_done' | 'off_track';
      explanation: string;
    }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'SKIP' }
  | { type: 'STUCK' }
  | { type: 'RETRY' }
  | { type: 'STOP' };

export type RunnerEffect =
  | {
      type: 'locate';
      token: number;
      step: Step;
      stepIndex: number;
      escalate: boolean;
      /** Wait for the screen to settle first (the user just acted). */
      settle: boolean;
      /** The step the user just did; checked only if this locate finds nothing. */
      previous: { stepIndex: number; step: Step } | null;
    }
  | { type: 'verify'; token: number; step: Step; stepIndex: number }
  | { type: 'show' }
  | { type: 'clear' }
  | { type: 'log_gap'; stepIndex: number; reason: 'runner_stuck' };

export const initialState: RunnerState = {
  phase: 'IDLE',
  procedure: null,
  stepIndex: 0,
  token: 0,
  attempts: 0,
  found: null,
  notice: null,
  outcomes: [],
};

export interface Transition {
  state: RunnerState;
  effects: RunnerEffect[];
}

const needsTarget = (step: Step) =>
  step.action !== 'manual' && step.action !== 'wait' && !!step.target;

/** Notices that stay visible while the step is highlighted again. */
const STICKY: ReadonlySet<NoticeKind> = new Set(['missed', 'wrong_click']);

interface EnterOptions {
  escalate?: boolean;
  keepAttempts?: boolean;
  settle?: boolean;
  previous?: { stepIndex: number; step: Step } | null;
  notice?: RunnerState['notice'];
}

/** Enter a step: locate its target, or go straight to text-only for steps without one. */
function enterStep(s: RunnerState, stepIndex: number, opts: EnterOptions = {}): Transition {
  const procedure = s.procedure!;
  const step = procedure.steps[stepIndex]!;
  const attempts = opts.keepAttempts ? s.attempts + 1 : 1;
  if (!needsTarget(step)) {
    return {
      state: {
        ...s,
        phase: 'TEXT_ONLY',
        stepIndex,
        attempts,
        found: null,
        notice: opts.notice ?? { kind: 'no_target', hint: '' },
      },
      effects: [{ type: 'clear' }, { type: 'show' }],
    };
  }
  const token = s.token + 1;
  return {
    state: {
      ...s,
      phase: opts.escalate ? 'RECOVERING' : 'LOCATING',
      stepIndex,
      token,
      attempts,
      found: null,
      notice: opts.notice ?? null,
    },
    effects: [
      { type: 'clear' },
      { type: 'show' },
      {
        type: 'locate',
        token,
        step,
        stepIndex,
        escalate: !!opts.escalate,
        settle: !!opts.settle,
        previous: opts.previous ?? null,
      },
    ],
  };
}

function complete(s: RunnerState, outcomes: StepOutcome[]): Transition {
  return {
    state: { ...s, phase: 'COMPLETE', outcomes, found: null, notice: null },
    effects: [{ type: 'clear' }, { type: 'show' }],
  };
}

function advance(s: RunnerState, outcome: StepOutcome, viaAction = false): Transition {
  const outcomes = [...s.outcomes];
  outcomes[s.stepIndex] = outcome;
  const steps = s.procedure!.steps;
  const next = s.stepIndex + 1;

  if (next >= steps.length) {
    // The user did the last step themselves: confirm it before saying "done".
    if (viaAction) {
      const token = s.token + 1;
      return {
        state: { ...s, phase: 'VERIFYING', outcomes, token, found: null, notice: null },
        effects: [
          { type: 'clear' },
          { type: 'show' },
          { type: 'verify', token, step: steps[s.stepIndex]!, stepIndex: s.stepIndex },
        ],
      };
    }
    return complete(s, outcomes);
  }
  return enterStep(
    { ...s, outcomes },
    next,
    viaAction
      ? { settle: true, previous: { stepIndex: s.stepIndex, step: steps[s.stepIndex]! } }
      : {},
  );
}

const awaitingLocate = (s: RunnerState, token: number) =>
  token === s.token && (s.phase === 'LOCATING' || s.phase === 'RECOVERING');

export function reduce(s: RunnerState, e: RunnerEvent): Transition {
  const none: Transition = { state: s, effects: [] };
  const active = s.phase !== 'IDLE' && s.phase !== 'COMPLETE';

  switch (e.type) {
    case 'START': {
      if (e.procedure.steps.length === 0) return none;
      return enterStep(
        { ...initialState, token: s.token, procedure: e.procedure, outcomes: [] },
        0,
      );
    }

    case 'LOCATED': {
      if (!awaitingLocate(s, e.token)) return none;
      if (e.result.kind === 'found') {
        const notice = s.notice && STICKY.has(s.notice.kind) ? s.notice : null;
        return {
          state: { ...s, phase: 'HIGHLIGHTING', found: e.result, notice },
          effects: [{ type: 'show' }],
        };
      }
      const wrongApp = e.result.reason === 'wrong_app';
      const recovering = s.phase === 'RECOVERING';
      return {
        state: {
          ...s,
          phase: wrongApp ? 'NEEDS_NAVIGATION' : 'TEXT_ONLY',
          found: null,
          notice: {
            kind: wrongApp ? 'wrong_app' : recovering ? 'stuck' : 'not_found',
            hint: e.result.hint,
          },
        },
        effects: [
          { type: 'clear' },
          { type: 'show' },
          ...(recovering && !wrongApp
            ? [
                {
                  type: 'log_gap' as const,
                  stepIndex: s.stepIndex,
                  reason: 'runner_stuck' as const,
                },
              ]
            : []),
        ],
      };
    }

    case 'AHEAD': {
      if (!awaitingLocate(s, e.token) || e.stepIndex <= s.stepIndex) return none;
      if (e.stepIndex >= s.procedure!.steps.length) return none;
      const outcomes = [...s.outcomes];
      for (let i = s.stepIndex; i < e.stepIndex; i++) outcomes[i] = 'done';
      return {
        state: {
          ...s,
          phase: 'HIGHLIGHTING',
          stepIndex: e.stepIndex,
          outcomes,
          found: e.result,
          notice: null,
          attempts: 1,
        },
        effects: [{ type: 'clear' }, { type: 'show' }],
      };
    }

    case 'SYNC': {
      if (!active || s.phase === 'VERIFYING') return none;
      if (e.stepIndex < 0 || e.stepIndex >= s.procedure!.steps.length) return none;
      const outcomes: StepOutcome[] = s.outcomes.slice(0, e.stepIndex);
      for (let i = 0; i < e.stepIndex; i++) outcomes[i] ??= 'done';
      return {
        state: {
          ...s,
          phase: 'HIGHLIGHTING',
          stepIndex: e.stepIndex,
          token: s.token + 1,
          attempts: 1,
          found: e.result,
          notice: e.notice ?? null,
          outcomes,
        },
        effects: [{ type: 'clear' }, { type: 'show' }],
      };
    }

    case 'GOTO': {
      if (!active || s.phase === 'VERIFYING') return none;
      if (e.stepIndex < 0 || e.stepIndex >= s.procedure!.steps.length) return none;
      const outcomes: StepOutcome[] = s.outcomes.slice(0, e.stepIndex);
      for (let i = 0; i < e.stepIndex; i++) outcomes[i] ??= 'done';
      return enterStep({ ...s, outcomes }, e.stepIndex);
    }

    case 'LOST': {
      if (!active || s.phase === 'VERIFYING') return none;
      return {
        state: {
          ...s,
          phase: 'TEXT_ONLY',
          token: s.token + 1,
          found: null,
          notice: { kind: 'not_found', hint: e.hint },
        },
        effects: [{ type: 'clear' }, { type: 'show' }],
      };
    }

    case 'FINISHED': {
      if (!active) return none;
      const outcomes = s.procedure!.steps.map((_, i) => s.outcomes[i] ?? ('done' as const));
      const done = complete(s, outcomes);
      return e.missed.length
        ? {
            ...done,
            state: { ...done.state, notice: { kind: 'missed', hint: e.missed.join(' ') } },
          }
        : done;
    }

    case 'USER_CHOICE': {
      if (!awaitingLocate(s, e.token)) return none;
      return {
        state: {
          ...s,
          phase: 'TEXT_ONLY',
          found: null,
          notice: { kind: 'no_target', hint: e.hint },
        },
        effects: [{ type: 'clear' }, { type: 'show' }],
      };
    }

    case 'LOCATE_FAILED': {
      if (!awaitingLocate(s, e.token)) return none;
      return {
        state: { ...s, phase: 'TEXT_ONLY', found: null, notice: { kind: 'error', hint: '' } },
        effects: [{ type: 'clear' }, { type: 'show' }],
      };
    }

    case 'ACTED':
      return s.phase === 'HIGHLIGHTING' ? advance(s, 'done', true) : none;

    case 'WRONG_CLICK':
      // The screen may have changed under the click: look again, and say why.
      return s.phase === 'HIGHLIGHTING'
        ? enterStep(s, s.stepIndex, {
            keepAttempts: true,
            settle: true,
            notice: { kind: 'wrong_click', hint: '' },
          })
        : none;

    case 'PREVIOUS_NOT_DONE': {
      if (!awaitingLocate(s, e.token) || e.stepIndex >= s.stepIndex) return none;
      const outcomes = s.outcomes.slice(0, e.stepIndex);
      return enterStep({ ...s, outcomes }, e.stepIndex, {
        notice: { kind: 'missed', hint: e.explanation },
      });
    }

    case 'OFF_TRACK': {
      if (!awaitingLocate(s, e.token) && !(s.phase === 'VERIFYING' && e.token === s.token)) {
        return none;
      }
      return {
        state: {
          ...s,
          phase: 'TEXT_ONLY',
          found: null,
          notice: { kind: 'off_track', hint: e.explanation },
        },
        effects: [{ type: 'clear' }, { type: 'show' }],
      };
    }

    case 'VERIFIED': {
      if (s.phase !== 'VERIFYING' || e.token !== s.token) return none;
      if (e.status === 'done') return complete(s, s.outcomes);
      if (e.status === 'off_track') {
        return {
          state: { ...s, phase: 'TEXT_ONLY', notice: { kind: 'off_track', hint: e.explanation } },
          effects: [{ type: 'clear' }, { type: 'show' }],
        };
      }
      const outcomes = s.outcomes.slice(0, s.stepIndex);
      return enterStep({ ...s, outcomes }, s.stepIndex, {
        notice: { kind: 'missed', hint: e.explanation },
      });
    }

    case 'NEXT':
      return active ? advance(s, 'done') : none;

    case 'SKIP':
      return active ? advance(s, 'skipped') : none;

    case 'BACK':
      return active && s.stepIndex > 0 ? enterStep(s, s.stepIndex - 1) : none;

    case 'RETRY':
      return active ? enterStep(s, s.stepIndex, { keepAttempts: true }) : none;

    case 'STUCK':
      // Try again with the stronger model; if that also fails, log a gap.
      return active ? enterStep(s, s.stepIndex, { escalate: true, keepAttempts: true }) : none;

    case 'STOP':
      return s.phase === 'IDLE'
        ? none
        : {
            state: { ...initialState, token: s.token },
            effects: [{ type: 'clear' }, { type: 'show' }],
          };
  }
}
