import { describe, expect, it } from 'vitest';
import { buildVerifyV1, interpretVerifyV1, VERIFY_V1 } from './v1';

const screen = (label: string) => ({ label, width: 1280, height: 720, jpeg: Buffer.from('x') });

describe('verify.v1', () => {
  it('sends before and after screenshots and the expected result', () => {
    const req = buildVerifyV1({
      step: {
        instruction: 'Open the Table menu.',
        action: 'click',
        app: { name: 'LibreOffice Writer', kind: 'native' },
        expectedAfter: 'The Table menu is open.',
      },
      before: [screen('screen_1')],
      after: [screen('screen_1')],
    });
    expect(req.promptId).toBe(VERIFY_V1);
    const texts = req.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text);
    expect(texts[0]).toBe('BEFORE screen_1 (1280x720 px):');
    expect(texts[1]).toBe('AFTER screen_1 (1280x720 px):');
    expect(texts.at(-1)).toContain('Expected result: The Table menu is open.');
  });

  it('accepts valid answers', () => {
    expect(interpretVerifyV1({ status: 'done', explanation: 'The menu is open.' })).toEqual({
      status: 'done',
      explanation: 'The menu is open.',
    });
  });

  it('treats anything unusable as not_done', () => {
    expect(interpretVerifyV1({ status: 'probably' })).toEqual({
      status: 'not_done',
      explanation: '',
    });
    expect(interpretVerifyV1('yes')).toEqual({ status: 'not_done', explanation: '' });
  });
});
