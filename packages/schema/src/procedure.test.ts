import { describe, expect, it } from 'vitest';
import { BBox, bboxWithin } from './common';
import { Procedure, Step } from './procedure';

const ids = {
  proc: '6b1f0c1e-4c1a-4f38-9b3a-1f6f0c1e4c1a',
  tenant: '0e7d6f5a-2b4c-4d3e-8f1a-9b8c7d6e5f4a',
  owner: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
};

const clickStep = {
  id: 's1',
  instruction: 'Click "New request"',
  app: { name: 'ServiceNow', kind: 'web' },
  action: 'click',
  target: { description: 'Blue "New request" button in the top bar', text: 'New request' },
  expectedAfter: 'The request form opens',
};

function procedure(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.proc,
    tenantId: ids.tenant,
    ownerId: ids.owner,
    visibility: 'private',
    status: 'draft',
    version: 1,
    source: 'doc',
    title: 'Request access to Salesforce',
    apps: [{ name: 'ServiceNow', kind: 'web' }],
    variables: [{ name: 'manager', label: "Manager's email" }],
    steps: [
      clickStep,
      {
        id: 's2',
        instruction: "Enter your manager's email",
        app: { name: 'ServiceNow', kind: 'web' },
        action: 'type',
        input: { var: 'manager' },
        target: { description: 'Approver field' },
      },
    ],
    ...overrides,
  };
}

describe('BBox', () => {
  it('accepts a well-formed box', () => {
    expect(BBox.parse([10, 20, 110, 60])).toEqual([10, 20, 110, 60]);
  });

  it.each([
    ['inverted x', [110, 20, 10, 60]],
    ['zero height', [10, 20, 110, 20]],
    ['negative', [-1, 0, 10, 10]],
    ['NaN', [Number.NaN, 0, 10, 10]],
    ['infinite', [0, 0, Number.POSITIVE_INFINITY, 10]],
    ['too short', [0, 0, 10]],
  ])('rejects %s', (_name, value) => {
    expect(BBox.safeParse(value).success).toBe(false);
  });

  it('bboxWithin checks image bounds', () => {
    expect(bboxWithin([0, 0, 1280, 800], 1280, 800)).toBe(true);
    expect(bboxWithin([0, 0, 1281, 800], 1280, 800)).toBe(false);
  });
});

describe('Step', () => {
  it('defaults optional to false and neighbors to []', () => {
    const step = Step.parse(clickStep);
    expect(step.optional).toBe(false);
    expect(step.target?.neighbors).toEqual([]);
  });

  it('requires a target for click-like actions', () => {
    const { target: _target, ...noTarget } = clickStep;
    const result = Step.safeParse(noTarget);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['target']);
  });

  it('allows manual and wait steps without a target', () => {
    expect(
      Step.safeParse({
        id: 'm1',
        instruction: 'Wait for the approval email',
        app: { name: 'Outlook', kind: 'native' },
        action: 'wait',
      }).success,
    ).toBe(true);
  });

  it('rejects unsafe step ids', () => {
    expect(Step.safeParse({ ...clickStep, id: 'has space' }).success).toBe(false);
  });
});

describe('Procedure', () => {
  it('parses a valid procedure', () => {
    expect(Procedure.safeParse(procedure()).success).toBe(true);
  });

  it('rejects duplicate step ids', () => {
    const p = procedure({ steps: [clickStep, clickStep] });
    const result = Procedure.safeParse(p);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/duplicate step id/);
  });

  it('rejects references to undeclared variables', () => {
    const result = Procedure.safeParse(procedure({ variables: [] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/unknown variable "manager"/);
  });

  it('rejects an empty step list', () => {
    expect(Procedure.safeParse(procedure({ steps: [] })).success).toBe(false);
  });

  it('rejects non-uuid tenant ids', () => {
    expect(Procedure.safeParse(procedure({ tenantId: 'acme' })).success).toBe(false);
  });
});
