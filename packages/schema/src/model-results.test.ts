import { describe, expect, it } from 'vitest';
import { AssessResult, LocateResult, VerifyResult } from './model-results';

const procedureId = '6b1f0c1e-4c1a-4f38-9b3a-1f6f0c1e4c1a';

describe('LocateResult', () => {
  it('parses a found result', () => {
    const r = LocateResult.parse({
      kind: 'found',
      screen: 'screen_1',
      bbox: [100, 200, 180, 230],
      confidence: 'high',
      label: 'Submit button',
    });
    expect(r.kind).toBe('found');
  });

  it('treats none as a valid result', () => {
    const r = LocateResult.parse({ kind: 'none', reason: 'ambiguous', hint: 'Two Save buttons' });
    expect(r.kind).toBe('none');
  });

  it('rejects low confidence on a found result (must be expressed as none)', () => {
    expect(
      LocateResult.safeParse({
        kind: 'found',
        screen: 'screen_1',
        bbox: [1, 1, 2, 2],
        confidence: 'low',
        label: 'x',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown kinds and reasons', () => {
    expect(LocateResult.safeParse({ kind: 'maybe' }).success).toBe(false);
    expect(LocateResult.safeParse({ kind: 'none', reason: 'tired', hint: '' }).success).toBe(false);
  });

  it('rejects malformed boxes', () => {
    expect(
      LocateResult.safeParse({
        kind: 'found',
        screen: 'screen_1',
        bbox: [200, 200, 100, 230],
        confidence: 'high',
        label: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('VerifyResult', () => {
  it('accepts the three statuses only', () => {
    expect(VerifyResult.safeParse({ status: 'not_done', explanation: '' }).success).toBe(true);
    expect(VerifyResult.safeParse({ status: 'probably', explanation: '' }).success).toBe(false);
  });
});

describe('AssessResult', () => {
  const step = { stepId: 's1', clarity: 'clear', note: '' };

  it('accepts ready with a procedure', () => {
    expect(
      AssessResult.safeParse({ verdict: 'ready', procedureId, steps: [step], gaps: [] }).success,
    ).toBe(true);
  });

  it('requires procedureId unless not_enough', () => {
    expect(AssessResult.safeParse({ verdict: 'ready', steps: [step], gaps: [] }).success).toBe(
      false,
    );
  });

  it('requires gaps for usable_with_gaps', () => {
    const base = { verdict: 'usable_with_gaps', procedureId, steps: [step] };
    expect(AssessResult.safeParse({ ...base, gaps: [] }).success).toBe(false);
    expect(
      AssessResult.safeParse({ ...base, gaps: [{ stepId: 's1', description: 'Which form?' }] })
        .success,
    ).toBe(true);
  });

  it('requires missing for not_enough', () => {
    expect(AssessResult.safeParse({ verdict: 'not_enough', steps: [], gaps: [] }).success).toBe(
      false,
    );
    expect(
      AssessResult.safeParse({
        verdict: 'not_enough',
        steps: [],
        gaps: [],
        missing: 'No document covers VPN access',
      }).success,
    ).toBe(true);
  });
});
