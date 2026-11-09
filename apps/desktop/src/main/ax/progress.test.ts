import type { Step } from '@qhint/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessProgress, baselineOf, sameAddress, skippedBefore, wantsTicked } from './progress';
import type { AxElement } from './types';

const steps = (
  JSON.parse(
    readFileSync(join(__dirname, '../../../procedures/libreoffice-insert-table.json'), 'utf8'),
  ) as { steps: Step[] }
).steps;

const el = (o: Partial<AxElement> & { role: string }): AxElement => ({
  x: 100,
  y: 100,
  w: 80,
  h: 24,
  depth: 3,
  window: 0,
  ...o,
});

// LibreOffice Writer on macOS, as read by the helper.
const menuBar = ['File', 'Edit', 'Insert', 'Format', 'Table', 'Form'].map((t, i) =>
  el({ role: 'AXMenuBarItem', title: t, x: 135 + i * 60, y: 0, w: 55, h: 39, window: -1 }),
);
const tableMenu = [
  el({ role: 'AXMenuItem', title: 'Insert Table…', x: 439, y: 45, w: 311, window: -1 }),
  el({ role: 'AXMenuItem', title: 'Delete', x: 439, y: 93, w: 311, window: -1 }),
];
const dialog = (columns: string, header: '0' | '1') => [
  el({ role: 'AXUnknown', title: 'Columns:', value: columns, x: 722, y: 419, w: 155, h: 30 }),
  el({ role: 'AXUnknown', title: 'Rows:', value: '2', x: 1009, y: 419, w: 155, h: 30 }),
  el({ role: 'AXCheckBox', title: 'Header', value: header, x: 647, y: 484, w: 271, h: 22 }),
  el({ role: 'AXButton', title: 'Cancel', x: 984, y: 814 }),
  el({ role: 'AXButton', title: 'Insert', x: 1075, y: 814 }),
];

const at = (els: AxElement[], done?: Set<number>) => assessProgress(steps, els, done).current;

describe('assessProgress: follows the app state, whatever order the user acts in', () => {
  it('document only -> step 1 (open the Table menu)', () => {
    expect(at(menuBar)).toBe(0);
  });

  it('menu open -> step 2; menu closed again -> back to step 1', () => {
    expect(at([...menuBar, ...tableMenu])).toBe(1);
    expect(at(menuBar)).toBe(0);
  });

  it('dialog open with Columns 2 -> step 3, however the user got there', () => {
    expect(at([...menuBar, ...dialog('2', '0')])).toBe(2);
  });

  it('Columns already 4 (typed, arrows or pasted) -> step 4', () => {
    expect(at([...menuBar, ...dialog('4', '0')])).toBe(3);
  });

  it('Header ticked first, Columns still 2 -> stays on step 3 (earliest unfinished)', () => {
    expect(at([...menuBar, ...dialog('2', '1')])).toBe(2);
  });

  it('everything set -> step 5 (Insert)', () => {
    expect(at([...menuBar, ...dialog('4', '1')])).toBe(4);
  });

  it('a step the user finished another way counts as done', () => {
    expect(at([...menuBar, ...dialog('2', '0')], new Set([2]))).toBe(3);
  });

  it('nothing from the guide on screen -> null', () => {
    expect(at([el({ role: 'AXButton', title: 'OK' })])).toBeNull();
  });

  it('lists what was left undone before a step', () => {
    const p = assessProgress(steps, [...menuBar, ...dialog('4', '0')]);
    expect(skippedBefore(p, 4, steps)).toEqual([steps[3]!.instruction]);
    expect(
      skippedBefore(assessProgress(steps, [...menuBar, ...dialog('4', '1')]), 4, steps),
    ).toEqual([]);
  });
});

describe('wantsTicked', () => {
  it('reads the instruction', () => {
    expect(wantsTicked(steps[3]!)).toBe(true);
    expect(wantsTicked({ ...steps[3]!, instruction: 'Untick "Header".' })).toBe(false);
  });
});

describe('checkpoints (steps the app state cannot confirm)', () => {
  const withGate: Step[] = [
    steps[0]!, // Table menu
    steps[1]!, // Insert Table…
    {
      id: 'g',
      instruction: 'Check the table preview.',
      app: steps[0]!.app,
      action: 'manual',
      optional: false,
    },
    steps[4]!, // Insert
  ];

  it('the user is still before the checkpoint: follow the app as usual', () => {
    expect(assessProgress(withGate, menuBar)).toMatchObject({ current: 0, checkpoint: false });
    expect(assessProgress(withGate, [...menuBar, ...tableMenu])).toMatchObject({
      current: 1,
      checkpoint: false,
    });
  });

  it('a later step is already visible: stop at the checkpoint first', () => {
    expect(assessProgress(withGate, [...menuBar, ...dialog('4', '1')])).toMatchObject({
      current: 2,
      checkpoint: true,
    });
  });

  it('once the user has done the checkpoint, carry on', () => {
    expect(assessProgress(withGate, [...menuBar, ...dialog('4', '1')], new Set([2]))).toMatchObject(
      {
        current: 3,
        checkpoint: false,
      },
    );
  });

  it('an unlabelled control is a checkpoint too', () => {
    const icon: Step = {
      ...steps[4]!,
      id: 'icon',
      target: { description: 'The PDF icon', neighbors: [] },
    };
    const p = assessProgress([steps[0]!, icon, steps[4]!], [...menuBar, ...dialog('4', '1')]);
    expect(p).toMatchObject({ current: 1, checkpoint: true });
  });
});

describe('elements that were there all along', () => {
  // Writer's toolbar has an "Open" button; the guide's "Open" step means the file dialog's.
  const toolbarOpen = el({ role: 'AXMenuButton', title: 'Open', x: 300, y: 150, window: 0 });
  const dialogOpen = el({ role: 'AXButton', title: 'Open', x: 900, y: 700, window: 0 });
  const fileMenu = el({
    role: 'AXMenuBarItem',
    title: 'File',
    x: 135,
    y: 0,
    w: 43,
    h: 39,
    window: -1,
  });
  const openItem = el({ role: 'AXMenuItem', title: 'Open...', x: 135, y: 60, w: 200, window: -1 });
  const calc: Step[] = [
    {
      ...steps[0]!,
      id: 'a',
      target: { description: 'File menu', text: 'File', role: 'menu', neighbors: [] },
    },
    {
      ...steps[1]!,
      id: 'b',
      target: { description: 'Open item', text: 'Open...', role: 'menu item', neighbors: [] },
    },
    {
      ...steps[4]!,
      id: 'c',
      target: { description: 'Open button', text: 'Open', role: 'button', neighbors: [] },
    },
  ];
  const start = [fileMenu, { ...toolbarOpen, window: 1 }];
  const baseline = baselineOf(calc, start);

  it('a button that was already there does not make the guide jump ahead', () => {
    expect(assessProgress(calc, start, { baseline, shown: 0 }).current).toBe(0);
    // Without the baseline it would have jumped to the end.
    expect(assessProgress(calc, start).current).toBe(2);
  });

  it('the menu opening moves on as usual', () => {
    expect(assessProgress(calc, [...start, openItem], { baseline, shown: 0 }).current).toBe(1);
  });

  it('the file dialog’s own Open button counts once it appears', () => {
    expect(assessProgress(calc, [...start, dialogOpen], { baseline, shown: 1 }).current).toBe(2);
  });

  it('steps up to the one shown may still match what was there all along', () => {
    // Once the guide is showing the Open step, any visible "Open" counts for it.
    expect(assessProgress(calc, start, { baseline, shown: 2 }).current).toBe(2);
  });
});

describe('option buttons', () => {
  it('a "make sure X is selected" step is done once that option is selected', () => {
    const pick: Step = {
      ...steps[3]!,
      id: 'r',
      instruction: 'Make sure "Separated by" is selected.',
      target: {
        description: 'Separated by option',
        text: 'Separated by',
        role: 'radio button',
        neighbors: [],
      },
    };
    const radio = (v: string) => el({ role: 'AXRadioButton', title: 'Separated by', value: v });
    expect(assessProgress([pick, steps[4]!], [radio('0'), ...dialog('4', '1')]).current).toBe(0);
    expect(assessProgress([pick, steps[4]!], [radio('1'), ...dialog('4', '1')]).current).toBe(1);
  });
});

describe('"go to this address" steps', () => {
  const go: Step = {
    id: 'go',
    instruction: 'Go to the Sandbox page.',
    app: { name: 'Wikipedia (web)', kind: 'web' },
    action: 'navigate',
    input: 'https://en.wikipedia.org/wiki/Wikipedia:Sandbox?veaction=edit',
    optional: false,
  };
  const bar = (value = '') =>
    el({
      role: 'AXTextField',
      title: 'Address and search bar',
      value,
      x: 200,
      y: 60,
      w: 600,
      window: 0,
    });
  const page = (url: string) =>
    el({ role: 'AXWebArea', url, x: 0, y: 100, w: 1200, h: 700, window: 0 });
  const save = {
    ...steps[4]!,
    id: 'save',
    app: go.app,
    target: { description: 'Publish', text: 'Publish changes', role: 'button', neighbors: [] },
  };

  it('points at the address bar until the browser is on that page', () => {
    const p = assessProgress([go, save], [bar(), page('https://www.wikipedia.org/')]);
    expect(p.current).toBe(0);
    expect(p.steps[0]!.match?.element.title).toBe('Address and search bar');
  });

  it('is done once the page address matches (www, trailing slash and extra parameters ignored)', () => {
    const there = page('https://en.wikipedia.org/wiki/Wikipedia:Sandbox?veaction=edit&oldid=1');
    expect(assessProgress([go, save], [bar(), there]).steps[0]!.satisfied).toBe(true);
  });

  it('is not done on the right page without the needed setting (no ?veaction=edit)', () => {
    const view = page('https://en.wikipedia.org/wiki/Wikipedia:Sandbox');
    expect(assessProgress([go, save], [bar(), view]).current).toBe(0);
  });

  it('without an address to go to, it is a checkpoint the user does themselves', () => {
    const noValue: Step = { ...go, input: { var: 'page_url' } };
    expect(assessProgress([noValue, save], [bar()])).toMatchObject({
      current: 0,
      checkpoint: true,
    });
  });
});

describe('sameAddress', () => {
  it('compares site and path, and requires the wanted parameters', () => {
    expect(sameAddress('https://www.example.com/a/', 'example.com/a')).toBe(true);
    expect(sameAddress('https://example.com/a?x=1&y=2', 'https://example.com/a?x=1')).toBe(true);
    expect(sameAddress('https://example.com/a?x=2', 'https://example.com/a?x=1')).toBe(false);
    expect(sameAddress('https://example.com/b', 'https://example.com/a')).toBe(false);
    expect(sameAddress('https://evil.com/example.com/a', 'https://example.com/a')).toBe(false);
    expect(sameAddress('not a url at all', 'https://example.com')).toBe(false);
  });
});
