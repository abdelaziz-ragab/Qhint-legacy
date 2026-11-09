import type { Procedure } from '@qhint/schema';
import { describe, expect, it } from 'vitest';
import { sourceType, withVariables } from './service';

describe('sourceType', () => {
  it('knows videos and documents by extension, case-insensitively', () => {
    expect(sourceType('/x/clip.MP4')).toMatchObject({ kind: 'video', contentType: 'video/mp4' });
    expect(sourceType('/x/rec.mov')).toMatchObject({
      kind: 'video',
      contentType: 'video/quicktime',
    });
    expect(sourceType('C:\\docs\\sop.pdf')).toMatchObject({ kind: 'doc' });
    expect(sourceType('/x/notes.md')).toMatchObject({ contentType: 'text/markdown' });
  });
  it('rejects anything else', () => {
    expect(sourceType('/x/report.docx')).toBeNull();
    expect(sourceType('/x/app.exe')).toBeNull();
    expect(sourceType('/x/noext')).toBeNull();
  });
});

const guide = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  ownerId: '00000000-0000-4000-8000-000000000003',
  visibility: 'private',
  status: 'draft',
  version: 1,
  source: 'video',
  title: 'Import data',
  apps: [],
  variables: [
    { name: 'data_file', label: 'File to import' },
    { name: 'sheet', label: 'Sheet name' },
  ],
  steps: [
    {
      id: 's1',
      instruction: 'Select the file you want to import.',
      app: { name: 'LibreOffice Calc', kind: 'native' },
      action: 'click',
      input: { var: 'data_file' },
      target: { description: 'The file you want to import', neighbors: [] },
      optional: false,
    },
    {
      id: 's2',
      instruction: 'Type the sheet name.',
      app: { name: 'LibreOffice Calc', kind: 'native' },
      action: 'type',
      input: { var: 'sheet' },
      target: { description: 'Name field', text: 'Name', neighbors: [] },
      optional: false,
    },
    {
      id: 's3',
      instruction: 'Click OK.',
      app: { name: 'LibreOffice Calc', kind: 'native' },
      action: 'click',
      target: { description: 'OK button', text: 'OK', neighbors: [] },
      optional: false,
    },
  ],
} as Procedure;

describe('withVariables', () => {
  it('fills in values: typed text, and the label of a clicked item', () => {
    const g = withVariables(guide, { data_file: 'sales.csv', sheet: ' Q3 ' });
    expect(g.steps[0]).toMatchObject({ input: 'sales.csv', target: { text: 'sales.csv' } });
    // Typing keeps the field's own label as the target.
    expect(g.steps[1]).toMatchObject({ input: 'Q3', target: { text: 'Name' } });
    expect(g.steps[2]).toEqual(guide.steps[2]);
  });

  it('leaves steps alone when a value is missing or blank', () => {
    const g = withVariables(guide, { sheet: '   ' });
    expect(g.steps[0]).toEqual(guide.steps[0]);
    expect(g.steps[1]).toEqual(guide.steps[1]);
  });

  it('does not change the original guide', () => {
    withVariables(guide, { data_file: 'x' });
    expect(guide.steps[0]!.input).toEqual({ var: 'data_file' });
  });
});
