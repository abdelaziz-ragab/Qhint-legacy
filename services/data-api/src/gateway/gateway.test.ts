import { LocateResult, OperatorEvent } from '@qhint/schema';
import { describe, expect, it } from 'vitest';
import { defaultGatewayConfig } from './config';
import { FakeModelProvider } from './fake-provider';
import { costMicroUsd, ModelGateway, parseStrictJson } from './gateway';
import type { ModelRequest } from './types';

const caller = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000101',
};
const request: ModelRequest = {
  system: 'You locate UI targets.',
  content: [{ type: 'text', text: 'Find the button that approves Jane Doe’s salary change' }],
  maxTokens: 512,
};
const found = JSON.stringify({
  kind: 'found',
  screen: 'screen_1',
  bbox: [10, 10, 50, 30],
  confidence: 'high',
  label: 'Approve',
});

function setup(respond: (model: string) => string | Error) {
  const events: OperatorEvent[] = [];
  const provider = new FakeModelProvider((m) => respond(m));
  const gateway = new ModelGateway(provider, defaultGatewayConfig('k'.repeat(32)), (e) =>
    events.push(e),
  );
  return { gateway, provider, events };
}

describe('ModelGateway', () => {
  it('returns validated JSON from the primary model for the call type', async () => {
    const { gateway, provider } = setup(() => found);
    const r = await gateway.call('locate', caller, request, LocateResult);
    expect(r.ok && r.value.kind).toBe('found');
    expect(provider.calls[0]!.model).toBe('claude-haiku-5-5');
  });

  it('uses the escalation model when asked', async () => {
    const { gateway, provider } = setup(() => found);
    await gateway.call('locate', caller, request, LocateResult, 'escalation');
    expect(provider.calls[0]!.model).toBe('claude-sonnet-5-5');
  });

  it('routes ingest and assess to Sonnet', async () => {
    const { gateway, provider } = setup(() => '{}');
    await gateway.call('assess', caller, request, LocateResult);
    expect(provider.calls[0]!.model).toBe('claude-sonnet-5-5');
  });

  it('treats a "none" result as success', async () => {
    const { gateway } = setup(() =>
      JSON.stringify({ kind: 'none', reason: 'ambiguous', hint: 'two buttons' }),
    );
    const r = await gateway.call('locate', caller, request, LocateResult);
    expect(r.ok && r.value.kind).toBe('none');
  });

  it.each([
    ['prose', 'Sure! The button is at the top.'],
    ['wrong shape', JSON.stringify({ kind: 'found', bbox: [1, 2] })],
    [
      'low confidence found',
      JSON.stringify({
        kind: 'found',
        screen: 's',
        bbox: [1, 1, 2, 2],
        confidence: 'low',
        label: 'x',
      }),
    ],
    ['trailing text', `${found} hope that helps`],
  ])('rejects %s as invalid_output (never guesses)', async (_name, text) => {
    const { gateway } = setup(() => text);
    const r = await gateway.call('locate', caller, request, LocateResult);
    expect(r).toMatchObject({ ok: false, code: 'invalid_output' });
  });

  it('reports provider failures', async () => {
    const { gateway } = setup(() => new Error('upstream 529'));
    expect(await gateway.call('verify', caller, request, LocateResult)).toMatchObject({
      ok: false,
      code: 'provider_error',
    });
  });

  it('emits one content-free, whitelisted event per call', async () => {
    const { gateway, events } = setup(() => found);
    await gateway.call('locate', { ...caller, appCategory: 'web' }, request, LocateResult);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(OperatorEvent.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      type: 'model_call',
      callType: 'locate',
      model: 'claude-haiku-5-5',
      outcome: 'ok',
      appCategory: 'web',
    });
    const serialized = JSON.stringify(e);
    expect(serialized).not.toContain('salary');
    expect(serialized).not.toContain('Approve');
    expect(serialized).not.toContain(caller.tenantId);
    expect(serialized).not.toContain(caller.userId);
  });

  it('records failures with an outcome code too', async () => {
    const { gateway, events } = setup(() => 'not json');
    await gateway.call('locate', caller, request, LocateResult);
    expect(events[0]).toMatchObject({ outcome: 'invalid_output' });
    expect(OperatorEvent.safeParse(events[0]).success).toBe(true);
  });
});

describe('helpers', () => {
  it('parses strict JSON, allowing a single code fence', () => {
    expect(parseStrictJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseStrictJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseStrictJson('here: {"a":1}')).toThrow();
  });

  it('computes cost in micro-USD', () => {
    const price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
    expect(
      costMicroUsd(
        { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        price,
      ),
    ).toBe(500);
    expect(
      costMicroUsd(
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        undefined,
      ),
    ).toBe(0);
  });
});
