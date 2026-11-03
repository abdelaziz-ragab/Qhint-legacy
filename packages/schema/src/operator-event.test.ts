import { describe, expect, it } from 'vitest';
import { OperatorEvent } from './operator-event';

const hash = 'a'.repeat(64);

const modelCall = {
  type: 'model_call',
  ts: '2026-11-03T12:00:00.000Z',
  tenantHash: hash,
  userHash: hash,
  callType: 'locate',
  model: 'claude-haiku-5-5',
  inputTokens: 1800,
  outputTokens: 60,
  costMicroUsd: 2100,
  latencyMs: 900,
  cacheHit: false,
  outcome: 'found',
  appCategory: 'web',
};

describe('OperatorEvent (content-free whitelist)', () => {
  it('accepts a whitelisted model_call event', () => {
    expect(OperatorEvent.safeParse(modelCall).success).toBe(true);
  });

  it.each([
    ['question', 'how do I request VPN access?'],
    ['stepText', 'Click Submit'],
    ['appName', 'Salesforce'],
    ['windowTitle', 'Payroll - Jane Doe'],
    ['image', 'data:image/jpeg;base64,...'],
  ])('rejects non-whitelisted field %s', (field, value) => {
    expect(OperatorEvent.safeParse({ ...modelCall, [field]: value }).success).toBe(false);
  });

  it('rejects raw (unhashed) tenant ids', () => {
    expect(
      OperatorEvent.safeParse({ ...modelCall, tenantHash: '0e7d6f5a-2b4c-4d3e-8f1a-9b8c7d6e5f4a' })
        .success,
    ).toBe(false);
  });

  it('rejects free text smuggled into code fields', () => {
    expect(
      OperatorEvent.safeParse({ ...modelCall, failureCode: 'could not find the Submit button' })
        .success,
    ).toBe(false);
    expect(OperatorEvent.safeParse({ ...modelCall, model: 'Salesforce Admin' }).success).toBe(
      false,
    );
  });

  it('only allows app categories, not app names', () => {
    expect(OperatorEvent.safeParse({ ...modelCall, appCategory: 'citrix' }).success).toBe(true);
    expect(OperatorEvent.safeParse({ ...modelCall, appCategory: 'Workday' }).success).toBe(false);
  });

  it('rejects negative or fractional counters', () => {
    expect(OperatorEvent.safeParse({ ...modelCall, inputTokens: -1 }).success).toBe(false);
    expect(OperatorEvent.safeParse({ ...modelCall, latencyMs: 1.5 }).success).toBe(false);
  });
});
