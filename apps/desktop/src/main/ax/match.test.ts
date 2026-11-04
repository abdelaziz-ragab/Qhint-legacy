import type { Step } from '@qhint/schema';
import { describe, expect, it } from 'vitest';
import { allowedRoles, matchTarget, normalizeName, targetNames } from './match';
import type { AxElement } from './types';

const el = (o: Partial<AxElement> & { role: string }): AxElement => ({
  x: 100,
  y: 100,
  w: 80,
  h: 24,
  depth: 3,
  window: 0,
  ...o,
});

const step = (o: Partial<Step> & { target?: Step['target'] }): Step =>
  ({
    id: 's',
    instruction: 'x',
    app: { name: 'LibreOffice Writer', kind: 'native' },
    action: 'click',
    ...o,
  }) as Step;

// Shapes recorded from LibreOffice Writer on macOS.
const menuBar = ['File', 'Edit', 'View', 'Insert', 'Format', 'Styles', 'Table', 'Form'].map(
  (t, i) =>
    el({
      role: 'AXMenuBarItem',
      title: t,
      x: 135 + i * 50,
      y: 0,
      w: 50,
      h: 39,
      window: -1,
      depth: 1,
    }),
);
const toolbarTable = el({
  role: 'AXMenuButton',
  title: 'Table',
  description: 'Table',
  x: 763,
  y: 154,
});
const openTableMenu = [
  el({ role: 'AXMenu', x: 439, y: 40, w: 311, h: 556, window: -1, depth: 2 }),
  el({ role: 'AXMenuItem', title: 'Insert Table…', x: 439, y: 45, w: 311, window: -1 }),
  el({ role: 'AXMenuItem', title: 'Insert', x: 439, y: 69, w: 311, window: -1 }),
  el({ role: 'AXMenuItem', title: 'Delete', x: 439, y: 93, w: 311, window: -1 }),
];
const dialog = [
  el({ role: 'AXWindow', title: 'Insert Table', x: 627, y: 317, w: 546, h: 541, depth: 0 }),
  el({ role: 'AXStaticText', value: 'Columns:', x: 647, y: 419, w: 63, h: 30 }),
  el({ role: 'AXUnknown', title: 'Columns:', value: '2', x: 722, y: 419, w: 155, h: 30 }),
  el({ role: 'AXUnknown', title: 'Rows:', value: '2', x: 1009, y: 419, w: 155, h: 30 }),
  el({ role: 'AXCheckBox', title: 'Header', value: '0', x: 647, y: 484, w: 271, h: 22 }),
  el({
    role: 'AXCheckBox',
    title: 'Repeat header rows on new pages',
    x: 659,
    y: 512,
    w: 259,
    h: 22,
  }),
  el({ role: 'AXUnknown', title: 'Header rows:', value: '1', x: 778, y: 540, w: 90, h: 30 }),
  el({ role: 'AXButton', title: 'Cancel', x: 984, y: 814, w: 85, h: 31 }),
  el({ role: 'AXButton', title: 'Insert', x: 1075, y: 814, w: 85, h: 31 }),
];
// The document window sits behind the dialog.
const docWindow = [toolbarTable].map((e) => ({ ...e, window: 1 }));

const s1 = step({
  target: { description: 'The "Table" menu', text: 'Table', role: 'menu', neighbors: [] },
});
const s2 = step({
  target: {
    description: 'Insert Table item',
    text: 'Insert Table…',
    role: 'menu item',
    neighbors: [],
  },
});
const s3 = step({
  action: 'type',
  input: '4',
  target: { description: 'Columns field', text: 'Columns', role: 'spin button', neighbors: [] },
});
const s4 = step({
  target: { description: 'Header checkbox', text: 'Header', role: 'checkbox', neighbors: [] },
});
const s5 = step({
  target: { description: 'Insert button', text: 'Insert', role: 'button', neighbors: ['Cancel'] },
});

describe('normalizeName', () => {
  it('ignores case, ellipses, trailing colons, mnemonics and curly quotes', () => {
    expect(normalizeName('Insert Table…')).toBe('insert table');
    expect(normalizeName('Insert Table...')).toBe('insert table');
    expect(normalizeName('Columns: ')).toBe('columns');
    expect(normalizeName('&Save')).toBe('save');
    expect(normalizeName('Don’t split')).toBe("don't split");
  });
});

describe('targetNames', () => {
  it('uses target.text, else quoted names in the description', () => {
    expect(targetNames(s1)).toEqual(['table']);
    expect(
      targetNames(step({ target: { description: 'The "Save" button', neighbors: [] } })),
    ).toEqual(['save']);
    expect(
      targetNames(step({ target: { description: 'the save button', neighbors: [] } })),
    ).toEqual([]);
  });
});

describe('allowedRoles', () => {
  it('maps plain-language roles', () => {
    expect(allowedRoles(s1)).toContain('AXMenuBarItem');
    expect(allowedRoles(s1)).not.toContain('AXMenuButton');
    expect(allowedRoles(s2)).toEqual(['AXMenuItem', 'MenuItem']);
    expect(allowedRoles(s3)).toContain('AXUnknown');
    expect(allowedRoles(s4)).toContain('AXCheckBox');
  });
});

describe('matchTarget (LibreOffice Insert Table walkthrough)', () => {
  it('step 1: the Table menu in the menu bar, not the toolbar Table button', () => {
    const m = matchTarget(s1, [...menuBar, toolbarTable]);
    expect(m?.element.role).toBe('AXMenuBarItem');
    expect(m?.rect).toEqual({ x: 435, y: 0, width: 50, height: 39 });
  });

  it('step 2: "Insert Table…" only once the menu is open', () => {
    expect(matchTarget(s2, [...menuBar, toolbarTable])).toBeNull();
    expect(matchTarget(s2, [...menuBar, ...openTableMenu])?.rect.y).toBe(45);
  });

  it('step 3: the Columns field (not the Columns label text)', () => {
    expect(matchTarget(s3, [...menuBar, ...dialog, ...docWindow])?.element.role).toBe('AXUnknown');
    expect(matchTarget(s3, [...menuBar, ...dialog])?.rect.x).toBe(722);
  });

  it('step 4: the Header checkbox, not "Header rows" or "Repeat header rows"', () => {
    expect(matchTarget(s4, dialog)?.element.title).toBe('Header');
  });

  it('step 5: the dialog Insert button, not the Insert menu', () => {
    const m = matchTarget(s5, [...menuBar, ...dialog, ...docWindow]);
    expect(m?.element.role).toBe('AXButton');
    expect(m?.rect.x).toBe(1075);
  });

  it('with no role given, a window button beats the always-there menu bar', () => {
    const noRole = step({ target: { description: 'Insert', text: 'Insert', neighbors: [] } });
    expect(matchTarget(noRole, [...menuBar, ...dialog])?.element.role).toBe('AXButton');
  });
});

describe('matchTarget safety', () => {
  it('returns null when two equally good candidates exist and neighbors do not decide', () => {
    const twins = [
      el({ role: 'AXButton', title: 'OK', x: 100 }),
      el({ role: 'AXButton', title: 'OK', x: 900 }),
    ];
    const ok = step({ target: { description: 'OK', text: 'OK', role: 'button', neighbors: [] } });
    expect(matchTarget(ok, twins)).toBeNull();
  });

  it('uses neighbors to pick between twins', () => {
    const twins = [
      el({ role: 'AXButton', title: 'OK', x: 100 }),
      el({ role: 'AXButton', title: 'Cancel', x: 200 }),
      el({ role: 'AXButton', title: 'OK', x: 1600 }),
    ];
    const ok = step({
      target: { description: 'OK', text: 'OK', role: 'button', neighbors: ['Cancel'] },
    });
    expect(matchTarget(ok, twins)?.rect.x).toBe(100);
  });

  it('prefers the frontmost window', () => {
    const els = [
      el({ role: 'AXButton', title: 'OK', window: 1, x: 100 }),
      el({ role: 'AXButton', title: 'OK', window: 0, x: 500 }),
    ];
    const ok = step({ target: { description: 'OK', text: 'OK', role: 'button', neighbors: [] } });
    expect(matchTarget(ok, els)?.rect.x).toBe(500);
  });

  it('ignores disabled and tiny elements, and partial names', () => {
    const els = [
      el({ role: 'AXButton', title: 'Insert', enabled: false }),
      el({ role: 'AXButton', title: 'Insert', w: 2, h: 2 }),
      el({ role: 'AXButton', title: 'Insert Image' }),
    ];
    expect(matchTarget(s5, els)).toBeNull();
  });

  it('finds an unnamed field by the label to its left', () => {
    const els = [
      el({ role: 'AXStaticText', value: 'Email:', x: 100, y: 100, w: 60, h: 20 }),
      el({ role: 'AXTextField', x: 170, y: 98, w: 200, h: 24 }),
      el({ role: 'AXTextField', x: 170, y: 300, w: 200, h: 24 }),
    ];
    const email = step({
      action: 'type',
      input: 'a@b.c',
      target: { description: 'Email field', text: 'Email', role: 'text field', neighbors: [] },
    });
    expect(matchTarget(email, els)?.rect.y).toBe(98);
  });

  it('never matches manual steps or steps without a name to look for', () => {
    expect(matchTarget(step({ action: 'manual' }), menuBar)).toBeNull();
    expect(
      matchTarget(step({ target: { description: 'the blue button', neighbors: [] } }), menuBar),
    ).toBeNull();
  });
});
