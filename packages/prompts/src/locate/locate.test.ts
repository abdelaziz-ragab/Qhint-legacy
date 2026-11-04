import { describe, expect, it } from 'vitest';
import { buildLocateCuV1, CU_POINT_BOX, interpretLocateCuV1 } from './computer-use.v1';
import type { LocateInput } from './types';
import { buildLocateV1, interpretLocateV1, LOCATE_V1, LOCATE_V1_SCHEMA } from './v1';

const input: LocateInput = {
  screens: [
    { label: 'screen_1', width: 1280, height: 720, jpeg: Buffer.from('a') },
    { label: 'screen_2', width: 1280, height: 831, jpeg: Buffer.from('b') },
  ],
  step: {
    instruction: 'Click the Table menu',
    action: 'click',
    app: { name: 'LibreOffice Writer', kind: 'native' },
    target: {
      description: 'Table menu in the menu bar',
      text: 'Table',
      role: 'menu',
      neighbors: ['Format', 'Form'],
    },
  },
};

const found = (over: Record<string, unknown> = {}) => ({
  kind: 'found',
  screen: 'screen_1',
  bbox: [400, 10, 450, 30],
  confidence: 'high',
  label: 'Table menu',
  reason: null,
  hint: null,
  ...over,
});

describe('buildLocateV1', () => {
  it('labels each screenshot with its pixel size and includes the step', () => {
    const req = buildLocateV1(input);
    expect(req.promptId).toBe(LOCATE_V1);
    const texts = req.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text);
    expect(texts[0]).toBe('screen_1 (1280x720 px):');
    expect(texts[1]).toBe('screen_2 (1280x831 px):');
    expect(texts.at(-1)).toContain('Target text: "Table"');
    expect(texts.at(-1)).toContain('Nearby: Format; Form');
    expect(req.content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect(req.outputSchema).toBe(LOCATE_V1_SCHEMA);
    expect(req.effort).toBe('low');
  });

  it('adds the exemplar after the screenshots when present', () => {
    const req = buildLocateV1({
      ...input,
      exemplar: { jpeg: Buffer.from('e'), bbox: [0, 0, 10, 10] },
    });
    expect(req.content.filter((c) => c.type === 'image')).toHaveLength(3);
  });
});

describe('interpretLocateV1', () => {
  it('accepts a well-formed found result', () => {
    expect(interpretLocateV1(found(), input)).toEqual({
      kind: 'found',
      screen: 'screen_1',
      bbox: [400, 10, 450, 30],
      confidence: 'high',
      label: 'Table menu',
    });
  });

  it('passes "none" through, including the reason', () => {
    const r = interpretLocateV1(
      {
        ...found(),
        kind: 'none',
        screen: null,
        bbox: null,
        confidence: null,
        label: null,
        reason: 'not_visible',
        hint: 'Open the Table menu first',
      },
      input,
    );
    expect(r).toEqual({ kind: 'none', reason: 'not_visible', hint: 'Open the Table menu first' });
  });

  it.each([
    ['unknown screen', found({ screen: 'screen_9' })],
    ['box past the right edge', found({ bbox: [1200, 10, 1300, 30] })],
    [
      'box past the bottom of a shorter screen',
      found({ screen: 'screen_1', bbox: [10, 700, 50, 760] }),
    ],
    ['inverted box', found({ bbox: [450, 10, 400, 30] })],
    ['three numbers', found({ bbox: [1, 2, 3] })],
    ['negative', found({ bbox: [-5, 0, 10, 10] })],
    ['missing confidence', found({ confidence: null })],
    ['huge box (not one element)', found({ bbox: [0, 0, 1280, 700] })],
    ['garbage', 'the button is near the top'],
    ['empty', {}],
  ])('turns %s into none/low_confidence', (_name, output) => {
    expect(interpretLocateV1(output, input)).toMatchObject({
      kind: 'none',
      reason: 'low_confidence',
    });
  });

  it('allows a box on the taller second screen', () => {
    expect(
      interpretLocateV1(found({ screen: 'screen_2', bbox: [10, 760, 60, 800] }), input).kind,
    ).toBe('found');
  });
});

describe('computer-use variant', () => {
  it('uses only the screen under the cursor and the toolset', () => {
    const req = buildLocateCuV1(input);
    expect(req.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(req.tools).toEqual([{ type: 'computer_toolset_20260801' }]);
    expect(req.outputSchema).toBeUndefined();
  });

  it('turns one left_click into a small box around the point', () => {
    const r = interpretLocateCuV1(
      { text: '', toolCalls: [{ name: 'left_click', input: { coordinate: [425, 20] } }] },
      input,
    );
    expect(r).toEqual({
      kind: 'found',
      screen: 'screen_1',
      bbox: [425 - CU_POINT_BOX, 6, 425 + CU_POINT_BOX, 20 + CU_POINT_BOX],
      confidence: 'medium',
      label: 'click point',
    });
  });

  it.each([
    [
      'two clicks',
      [
        { name: 'left_click', input: { coordinate: [1, 1] } },
        { name: 'left_click', input: { coordinate: [2, 2] } },
      ],
    ],
    ['off-screen click', [{ name: 'left_click', input: { coordinate: [5000, 20] } }]],
    ['other action', [{ name: 'type', input: { text: 'x' } }]],
    ['bad coordinate', [{ name: 'left_click', input: { coordinate: ['a', 1] } }]],
  ])('rejects %s', (_name, toolCalls) => {
    expect(interpretLocateCuV1({ text: '', toolCalls }, input).kind).toBe('none');
  });

  it('reads a NONE reply', () => {
    expect(
      interpretLocateCuV1({ text: 'NONE wrong_app Open LibreOffice Writer', toolCalls: [] }, input),
    ).toEqual({
      kind: 'none',
      reason: 'wrong_app',
      hint: 'Open LibreOffice Writer',
    });
    expect(
      interpretLocateCuV1({ text: 'I think it is at the top', toolCalls: [] }, input),
    ).toMatchObject({
      reason: 'low_confidence',
    });
  });
});
