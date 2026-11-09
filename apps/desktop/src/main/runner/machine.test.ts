import type { LocateResult, Procedure } from '@qhint/schema';
import { describe, expect, it } from 'vitest';
import { initialState, reduce, type RunnerEvent, type RunnerState } from './machine';

const app = { name: 'LibreOffice Writer', kind: 'native' as const };
const click = (id: string) => ({
  id,
  instruction: `Click ${id}`,
  app,
  action: 'click' as const,
  target: { description: id, neighbors: [] },
  optional: false,
});
const procedure: Procedure = {
  id: '00000000-0000-4000-8000-0000000000aa',
  tenantId: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000101',
  visibility: 'company',
  status: 'published',
  version: 1,
  source: 'generated',
  title: 'Test',
  apps: [app],
  variables: [],
  steps: [
    click('s1'),
    { id: 's2', instruction: 'Wait for the dialog', app, action: 'wait', optional: false },
    click('s3'),
  ],
};
const found: LocateResult = {
  kind: 'found',
  screen: 'screen_1',
  bbox: [1, 1, 20, 20],
  confidence: 'high',
  label: 'x',
};
const notFound = (reason: 'not_visible' | 'wrong_app' | 'low_confidence'): LocateResult => ({
  kind: 'none',
  reason,
  hint: 'hint',
});

function play(events: RunnerEvent[], from: RunnerState = initialState) {
  let state = from;
  const effects = [];
  for (const e of events) {
    const t = reduce(state, e);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

describe('runner state machine', () => {
  it('starts by locating the first step', () => {
    const { state, effects } = play([{ type: 'START', procedure }]);
    expect(state.phase).toBe('LOCATING');
    expect(state.stepIndex).toBe(0);
    expect(effects).toContainEqual(
      expect.objectContaining({
        type: 'locate',
        stepIndex: 0,
        escalate: false,
        token: state.token,
      }),
    );
  });

  it('highlights when found, then moves on with Next', () => {
    let { state } = play([{ type: 'START', procedure }]);
    ({ state } = play([{ type: 'LOCATED', token: state.token, result: found }], state));
    expect(state.phase).toBe('HIGHLIGHTING');
    expect(state.found).toEqual(found);
    ({ state } = play([{ type: 'NEXT' }], state));
    // Step 2 is a "wait" step: no target, straight to text-only, no locate call.
    expect(state.phase).toBe('TEXT_ONLY');
    expect(state.notice?.kind).toBe('no_target');
    expect(state.outcomes).toEqual(['done']);
  });

  it('ignores late results from an earlier step', () => {
    let { state } = play([{ type: 'START', procedure }]);
    const oldToken = state.token;
    ({ state } = play([{ type: 'SKIP' }, { type: 'NEXT' }], state)); // now locating step 3
    expect(state.stepIndex).toBe(2);
    const late = reduce(state, { type: 'LOCATED', token: oldToken, result: found });
    expect(late.state).toBe(state);
    expect(late.effects).toEqual([]);
  });

  it('falls back to text-only guidance when the target isn’t found', () => {
    let { state } = play([{ type: 'START', procedure }]);
    ({ state } = play(
      [{ type: 'LOCATED', token: state.token, result: notFound('not_visible') }],
      state,
    ));
    expect(state.phase).toBe('TEXT_ONLY');
    expect(state.notice).toEqual({ kind: 'not_found', hint: 'hint' });
  });

  it('asks the user to open the right app on wrong_app, then retries', () => {
    let { state } = play([{ type: 'START', procedure }]);
    ({ state } = play(
      [{ type: 'LOCATED', token: state.token, result: notFound('wrong_app') }],
      state,
    ));
    expect(state.phase).toBe('NEEDS_NAVIGATION');
    const retry = reduce(state, { type: 'RETRY' });
    expect(retry.state.phase).toBe('LOCATING');
    expect(retry.state.attempts).toBe(2);
    expect(retry.effects).toContainEqual(
      expect.objectContaining({ type: 'locate', escalate: false }),
    );
  });

  it('“I’m stuck” re-locates with the stronger model and logs a gap if that fails too', () => {
    let { state } = play([{ type: 'START', procedure }]);
    ({ state } = play([{ type: 'LOCATED', token: state.token, result: found }], state));
    const stuck = reduce(state, { type: 'STUCK' });
    expect(stuck.state.phase).toBe('RECOVERING');
    expect(stuck.effects).toContainEqual(
      expect.objectContaining({ type: 'locate', escalate: true }),
    );
    const failed = reduce(stuck.state, {
      type: 'LOCATED',
      token: stuck.state.token,
      result: notFound('low_confidence'),
    });
    expect(failed.state.phase).toBe('TEXT_ONLY');
    expect(failed.state.notice?.kind).toBe('stuck');
    expect(failed.effects).toContainEqual({
      type: 'log_gap',
      stepIndex: 0,
      reason: 'runner_stuck',
    });
  });

  it('a network/model failure shows text-only guidance instead of hanging', () => {
    let { state } = play([{ type: 'START', procedure }]);
    ({ state } = play([{ type: 'LOCATE_FAILED', token: state.token }], state));
    expect(state.phase).toBe('TEXT_ONLY');
    expect(state.notice?.kind).toBe('error');
  });

  it('Back returns to the previous step; Back on the first step does nothing', () => {
    let { state } = play([{ type: 'START', procedure }]);
    expect(reduce(state, { type: 'BACK' }).state).toBe(state);
    ({ state } = play([{ type: 'NEXT' }, { type: 'NEXT' }, { type: 'BACK' }], state));
    expect(state.stepIndex).toBe(1);
  });

  it('completes after the last step and records outcomes', () => {
    const { state } = play([
      { type: 'START', procedure },
      { type: 'NEXT' },
      { type: 'SKIP' },
      { type: 'NEXT' },
    ]);
    expect(state.phase).toBe('COMPLETE');
    expect(state.outcomes).toEqual(['done', 'skipped', 'done']);
    expect(reduce(state, { type: 'NEXT' }).state).toBe(state);
  });

  it('Stop returns to idle from anywhere and clears the screen', () => {
    const { state } = play([{ type: 'START', procedure }]);
    const stopped = reduce(state, { type: 'STOP' });
    expect(stopped.state.phase).toBe('IDLE');
    expect(stopped.state.procedure).toBeNull();
    expect(stopped.effects).toContainEqual({ type: 'clear' });
  });

  it('a new run never accepts results from the previous run', () => {
    let { state } = play([{ type: 'START', procedure }]);
    const oldToken = state.token;
    ({ state } = play([{ type: 'STOP' }, { type: 'START', procedure }], state));
    expect(state.token).toBeGreaterThan(oldToken);
    expect(reduce(state, { type: 'LOCATED', token: oldToken, result: found }).state).toBe(state);
  });
});

describe('automatic progress', () => {
  const highlighted = () => {
    let { state } = play([{ type: 'START', procedure }]);
    ({ state } = play([{ type: 'LOCATED', token: state.token, result: found }], state));
    return state;
  };

  it('ACTED moves to the next step, waits for the screen to settle, and remembers what to check', () => {
    const t = reduce(highlighted(), { type: 'ACTED' });
    // Step 2 is a "wait" step without target, so it goes straight to text-only.
    expect(t.state.stepIndex).toBe(1);
    expect(t.state.outcomes).toEqual(['done']);
  });

  it('ACTED on a step followed by a targeted step locates it with settle + previous', () => {
    const p2: Procedure = { ...procedure, steps: [click('a'), click('b')] };
    let { state } = play([{ type: 'START', procedure: p2 }]);
    ({ state } = play([{ type: 'LOCATED', token: state.token, result: found }], state));
    const t = reduce(state, { type: 'ACTED' });
    expect(t.state.phase).toBe('LOCATING');
    expect(t.effects).toContainEqual(
      expect.objectContaining({
        type: 'locate',
        stepIndex: 1,
        settle: true,
        previous: expect.objectContaining({ stepIndex: 0 }),
      }),
    );
  });

  it('ACTED is ignored unless something is highlighted', () => {
    const { state } = play([{ type: 'START', procedure }]);
    expect(reduce(state, { type: 'ACTED' }).state).toBe(state);
  });

  it('a wrong click re-locates the same step and keeps the notice when found again', () => {
    const t = reduce(highlighted(), { type: 'WRONG_CLICK' });
    expect(t.state.phase).toBe('LOCATING');
    expect(t.state.stepIndex).toBe(0);
    expect(t.effects).toContainEqual(expect.objectContaining({ type: 'locate', settle: true }));
    const again = reduce(t.state, { type: 'LOCATED', token: t.state.token, result: found });
    expect(again.state.phase).toBe('HIGHLIGHTING');
    expect(again.state.notice?.kind).toBe('wrong_click');
  });

  it('PREVIOUS_NOT_DONE sends the user back to the missed step with an explanation', () => {
    const p2: Procedure = { ...procedure, steps: [click('a'), click('b')] };
    let { state } = play([{ type: 'START', procedure: p2 }]);
    ({ state } = play(
      [{ type: 'LOCATED', token: state.token, result: found }, { type: 'ACTED' }],
      state,
    ));
    const t = reduce(state, {
      type: 'PREVIOUS_NOT_DONE',
      token: state.token,
      stepIndex: 0,
      explanation: "The menu didn't open.",
    });
    expect(t.state.stepIndex).toBe(0);
    expect(t.state.outcomes).toEqual([]);
    expect(t.state.notice).toEqual({ kind: 'missed', hint: "The menu didn't open." });
  });

  it('the last step is verified before completing', () => {
    const p1: Procedure = { ...procedure, steps: [click('only')] };
    let { state } = play([{ type: 'START', procedure: p1 }]);
    ({ state } = play([{ type: 'LOCATED', token: state.token, result: found }], state));
    const acted = reduce(state, { type: 'ACTED' });
    expect(acted.state.phase).toBe('VERIFYING');
    expect(acted.effects).toContainEqual(expect.objectContaining({ type: 'verify', stepIndex: 0 }));

    const done = reduce(acted.state, {
      type: 'VERIFIED',
      token: acted.state.token,
      status: 'done',
      explanation: '',
    });
    expect(done.state.phase).toBe('COMPLETE');

    const missed = reduce(acted.state, {
      type: 'VERIFIED',
      token: acted.state.token,
      status: 'not_done',
      explanation: 'No table yet.',
    });
    expect(missed.state.phase).toBe('LOCATING');
    expect(missed.state.notice).toEqual({ kind: 'missed', hint: 'No table yet.' });

    const off = reduce(acted.state, {
      type: 'VERIFIED',
      token: acted.state.token,
      status: 'off_track',
      explanation: 'An error dialog appeared.',
    });
    expect(off.state.phase).toBe('TEXT_ONLY');
    expect(off.state.notice?.kind).toBe('off_track');
  });

  it('manual Next on the last step completes without a check', () => {
    const p1: Procedure = { ...procedure, steps: [click('only')] };
    const { state } = play([{ type: 'START', procedure: p1 }, { type: 'NEXT' }]);
    expect(state.phase).toBe('COMPLETE');
  });
});

describe('user is already ahead', () => {
  it('jumps to the later step whose target is visible and marks skipped ones done', () => {
    const p3: Procedure = { ...procedure, steps: [click('a'), click('b'), click('c')] };
    const { state } = play([{ type: 'START', procedure: p3 }]);
    const t = reduce(state, {
      type: 'AHEAD',
      token: state.token,
      stepIndex: 1,
      result: found as Extract<LocateResult, { kind: 'found' }>,
    });
    expect(t.state.phase).toBe('HIGHLIGHTING');
    expect(t.state.stepIndex).toBe(1);
    expect(t.state.outcomes).toEqual(['done']);
  });

  it('ignores stale or backwards jumps', () => {
    const p3: Procedure = { ...procedure, steps: [click('a'), click('b'), click('c')] };
    const { state } = play([{ type: 'START', procedure: p3 }]);
    const f = found as Extract<LocateResult, { kind: 'found' }>;
    expect(
      reduce(state, { type: 'AHEAD', token: state.token + 9, stepIndex: 1, result: f }).state,
    ).toBe(state);
    expect(
      reduce(state, { type: 'AHEAD', token: state.token, stepIndex: 0, result: f }).state,
    ).toBe(state);
    expect(
      reduce(state, { type: 'AHEAD', token: state.token, stepIndex: 7, result: f }).state,
    ).toBe(state);
  });
});

describe('live tracking events', () => {
  const p3: Procedure = { ...procedure, steps: [click('a'), click('b'), click('c')] };
  const f = found as Extract<LocateResult, { kind: 'found' }>;

  it('SYNC jumps forwards or backwards and highlights', () => {
    const { state } = play([{ type: 'START', procedure: p3 }]);
    const fwd = reduce(state, { type: 'SYNC', stepIndex: 2, result: f }).state;
    expect(fwd).toMatchObject({ phase: 'HIGHLIGHTING', stepIndex: 2, outcomes: ['done', 'done'] });
    const back = reduce(fwd, { type: 'SYNC', stepIndex: 0, result: f }).state;
    expect(back).toMatchObject({ phase: 'HIGHLIGHTING', stepIndex: 0, outcomes: [] });
    expect(back.token).toBeGreaterThan(fwd.token);
  });

  it('LOST shows a text notice; FINISHED completes and keeps what was missed', () => {
    const { state } = play([{ type: 'START', procedure: p3 }]);
    expect(reduce(state, { type: 'LOST', hint: 'h' }).state).toMatchObject({
      phase: 'TEXT_ONLY',
      notice: { kind: 'not_found', hint: 'h' },
    });
    const done = reduce(state, { type: 'FINISHED', missed: ['Tick Header.'] }).state;
    expect(done).toMatchObject({
      phase: 'COMPLETE',
      notice: { kind: 'missed', hint: 'Tick Header.' },
    });
    expect(reduce(state, { type: 'FINISHED', missed: [] }).state.notice).toBeNull();
  });

  it('ignores tracking events when no guide is running', () => {
    expect(reduce(initialState, { type: 'SYNC', stepIndex: 0, result: f }).state).toBe(
      initialState,
    );
  });
});

describe('GOTO (checkpoint during live tracking)', () => {
  it('enters the step the usual way, marking earlier steps done', () => {
    const p3: Procedure = { ...procedure, steps: [click('a'), click('b'), click('c')] };
    const { state } = play([{ type: 'START', procedure: p3 }]);
    const t = reduce(state, { type: 'GOTO', stepIndex: 1 });
    expect(t.state).toMatchObject({ phase: 'LOCATING', stepIndex: 1, outcomes: ['done'] });
    expect(t.effects.some((e) => e.type === 'locate')).toBe(true);
  });
});

describe('USER_CHOICE (a step that is the user’s own choice)', () => {
  it('shows the step as text with the hint, and ignores stale tokens', () => {
    const { state } = play([{ type: 'START', procedure }]);
    const t = reduce(state, { type: 'USER_CHOICE', token: state.token, hint: 'Pick your file.' });
    expect(t.state).toMatchObject({
      phase: 'TEXT_ONLY',
      notice: { kind: 'no_target', hint: 'Pick your file.' },
    });
    expect(reduce(state, { type: 'USER_CHOICE', token: state.token + 5, hint: 'x' }).state).toBe(
      state,
    );
  });
});
