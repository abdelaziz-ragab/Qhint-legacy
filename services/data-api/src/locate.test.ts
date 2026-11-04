import type { LocateInput } from '@qhint/prompts';
import { describe, expect, it } from 'vitest';
import { defaultGatewayConfig } from './gateway/config';
import { FakeModelProvider } from './gateway/fake-provider';
import { ModelGateway } from './gateway/gateway';
import { locate, shouldEscalate } from './locate';

const caller = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000101',
};
const input: LocateInput = {
  screens: [{ label: 'screen_1', width: 1280, height: 720, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }],
  step: {
    instruction: 'Click Insert',
    action: 'click',
    app: { name: 'LibreOffice Writer', kind: 'native' },
    target: {
      description: 'Insert button in the Insert Table dialog',
      text: 'Insert',
      neighbors: [],
    },
  },
};
const answer = (o: Record<string, unknown>) =>
  JSON.stringify({
    kind: 'found',
    screen: 'screen_1',
    bbox: [100, 100, 160, 124],
    confidence: 'high',
    label: 'Insert',
    reason: null,
    hint: null,
    ...o,
  });
const none = (reason: string) =>
  JSON.stringify({
    kind: 'none',
    screen: null,
    bbox: null,
    confidence: null,
    label: null,
    reason,
    hint: 'h',
  });

function run(replies: Record<string, string>) {
  const provider = new FakeModelProvider((model) => replies[model] ?? 'garbage');
  const gateway = new ModelGateway(provider, defaultGatewayConfig('k'.repeat(32)), () => {});
  return { provider, go: (variant: 'v1' | 'cu' = 'v1') => locate(gateway, caller, input, variant) };
}

describe('locate escalation', () => {
  it('accepts a confident Haiku answer without escalating', async () => {
    const { go, provider } = run({ 'claude-haiku-5-5': answer({}) });
    const r = await go();
    expect(r.result.kind).toBe('found');
    expect(r.escalated).toBe(false);
    expect(provider.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5']);
  });

  it.each([
    ['medium confidence', answer({ confidence: 'medium' })],
    ['low confidence', none('low_confidence')],
    ['ambiguous', none('ambiguous')],
    ['unusable output', 'not json'],
  ])('escalates to Sonnet on %s', async (_name, haiku) => {
    const { go } = run({ 'claude-haiku-5-5': haiku, 'claude-sonnet-5-5': answer({}) });
    const r = await go();
    expect(r.escalated).toBe(true);
    expect(r.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(r.result.kind).toBe('found');
  });

  it.each(['not_visible', 'wrong_app'])('trusts a clear "%s" from Haiku', async (reason) => {
    const { go } = run({ 'claude-haiku-5-5': none(reason) });
    const r = await go();
    expect(r.escalated).toBe(false);
    expect(r.result).toMatchObject({ kind: 'none', reason });
  });

  it('returns none when both models fail (never guesses)', async () => {
    const { go } = run({});
    const r = await go();
    expect(r.result).toMatchObject({ kind: 'none', reason: 'low_confidence' });
  });

  it('runs the computer-use variant on Sonnet only', async () => {
    const provider = new FakeModelProvider(() => ({
      text: '',
      toolCalls: [{ name: 'left_click', input: { coordinate: [130, 112] } }],
    }));
    const gateway = new ModelGateway(provider, defaultGatewayConfig('k'.repeat(32)), () => {});
    const r = await locate(gateway, caller, input, 'cu');
    expect(provider.calls.map((c) => c.model)).toEqual(['claude-sonnet-5-5']);
    expect(r.result.kind).toBe('found');
  });

  it('goes straight to Sonnet when the user is stuck', async () => {
    const { provider } = run({});
    const gateway = new ModelGateway(provider, defaultGatewayConfig('k'.repeat(32)), () => {});
    const r = await locate(gateway, caller, input, 'v1', { escalate: true });
    expect(provider.calls.map((c) => c.model)).toEqual(['claude-sonnet-5-5']);
    expect(r.escalated).toBe(true);
  });

  it('shouldEscalate', () => {
    expect(
      shouldEscalate({
        kind: 'found',
        screen: 's',
        bbox: [0, 0, 1, 1],
        confidence: 'high',
        label: '',
      }),
    ).toBe(false);
    expect(shouldEscalate({ kind: 'none', reason: 'wrong_app', hint: '' })).toBe(false);
  });
});
