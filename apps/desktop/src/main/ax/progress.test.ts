import type { Step } from '@qhint/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessProgress, skippedBefore, wantsTicked } from './progress';
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
