import { Procedure } from '@qhint/schema';
import { describe, expect, it } from 'vitest';
import { buildIngestDocV1, buildIngestVideoV1, INGEST_V1_SCHEMA, interpretIngestV1 } from './v1';

const frames = [
  { id: 'f01', t: 1.5, width: 1280, height: 720 },
  { id: 'f02', t: 4, width: 1280, height: 720 },
];

const step = (o: Record<string, unknown> = {}) => ({
  instruction: 'Open the File menu.',
  action: 'click',
  app_name: 'LibreOffice Calc',
  target_text: 'File',
  target_role: 'menu',
  target_description: 'The File menu in the menu bar',
  neighbors: ['Edit'],
  input_text: null,
  input_variable: null,
  expected_after: 'The File menu is open.',
  frame: 'f01',
  bbox: [40, 0, 80, 22],
  clarity: 'clear',
  note: null,
  ...o,
});

const answer = (steps: unknown[], o: Record<string, unknown> = {}) => ({
  verdict: 'ok',
  title: 'Import a CSV file into LibreOffice Calc',
  summary: 'Opens a comma-separated file as a spreadsheet.',
  apps: [{ name: 'LibreOffice Calc', kind: 'native' }],
  variables: [{ name: 'file_name', label: 'File to import', description: 'The .csv file' }],
  steps,
  problems: [],
  ...o,
});

const asProcedure = (d: NonNullable<ReturnType<typeof interpretIngestV1>>) =>
  Procedure.parse({
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-000000000002',
    ownerId: '00000000-0000-4000-8000-000000000003',
    visibility: 'private',
    status: 'draft',
    version: 1,
    source: 'video',
    title: d.title,
    apps: d.apps,
    variables: d.variables,
    steps: d.steps,
  });

describe('interpretIngestV1', () => {
  it('turns a clean answer into valid steps, a sighting for the example image, and a timestamp', () => {
    const d = interpretIngestV1(
      answer([
        step(),
        step({
          instruction: 'Type the file name.',
          action: 'type',
          target_text: 'File name',
          target_role: 'text field',
          target_description: 'The File name field',
          input_variable: 'file_name',
          frame: 'f02',
          bbox: [300, 400, 700, 430],
        }),
      ]),
      frames,
    )!;
    expect(d.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(d.steps[0]).toMatchObject({
      action: 'click',
      app: { name: 'LibreOffice Calc', kind: 'native' },
      target: { text: 'File', role: 'menu' },
      sourceTimestamp: 1.5,
    });
    expect(d.steps[1]!.input).toEqual({ var: 'file_name' });
    expect(d.sightings).toEqual([
      { stepId: 's1', frameId: 'f01', bbox: [40, 0, 80, 22] },
      { stepId: 's2', frameId: 'f02', bbox: [300, 400, 700, 430] },
    ]);
    expect(() => asProcedure(d)).not.toThrow();
  });

  it('makes a click with no identifiable target a manual step, and flags it', () => {
    const d = interpretIngestV1(answer([step({ target_description: null, bbox: null })]), frames)!;
    expect(d.steps[0]!.action).toBe('manual');
    expect(d.steps[0]!.target).toBeUndefined();
    expect(d.flagged[0]).toMatchObject({ stepId: 's1', clarity: 'vague' });
    expect(() => asProcedure(d)).not.toThrow();
  });

  it('drops boxes that are outside their frame, huge, or point at an unknown frame', () => {
    const d = interpretIngestV1(
      answer([
        step({ bbox: [1200, 700, 1400, 800] }),
        step({ bbox: [0, 0, 1280, 720] }),
        step({ frame: 'f99' }),
        step({ bbox: [50, 50, 40, 60] }),
      ]),
      frames,
    )!;
    expect(d.steps).toHaveLength(4);
    expect(d.sightings).toEqual([]);
  });

  it('ignores invalid or duplicate variables, and unknown variable references', () => {
    const d = interpretIngestV1(
      answer([step({ action: 'type', input_variable: 'nope', input_text: null })], {
        variables: [
          { name: 'ok_name', label: 'OK', description: '' },
          { name: 'ok_name', label: 'dup', description: '' },
          { name: '1bad', label: 'bad', description: '' },
        ],
      }),
      frames,
    )!;
    expect(d.variables.map((v) => v.name)).toEqual(['ok_name']);
    expect(d.steps[0]!.input).toBeUndefined();
  });

  it('flags unclear steps for the author', () => {
    const d = interpretIngestV1(
      answer([step({ clarity: 'needs_info', note: 'Which file is not shown.' })]),
      frames,
    )!;
    expect(d.flagged).toEqual([
      { stepId: 's1', clarity: 'needs_info', note: 'Which file is not shown.' },
    ]);
  });

  it('reports "not a procedure" when nothing usable came back', () => {
    expect(interpretIngestV1(answer([]), frames)!.verdict).toBe('not_a_procedure');
    expect(interpretIngestV1(answer([step({ instruction: '  ' })]), frames)!.verdict).toBe(
      'not_a_procedure',
    );
  });

  it('rejects malformed answers', () => {
    expect(interpretIngestV1({ nope: true })).toBeNull();
    expect(interpretIngestV1(answer([step({ action: 'teleport' })]))).toBeNull();
  });
});

describe('ingest prompts', () => {
  it('video: frames are labelled in order, the transcript is the cache breakpoint', () => {
    const req = buildIngestVideoV1({
      title: 'Import data',
      frames: frames.map((f) => ({ ...f, jpeg: Buffer.from([0xff, 0xd8, 0xff]) })),
      transcript: [{ start: 2, end: 3, text: 'Click File.' }],
      outputLanguage: 'English',
    });
    const texts = req.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text);
    expect(texts.some((t) => t.startsWith('f01 at 0:01 (1280x720 px)'))).toBe(true);
    const cached = req.content.filter((p) => p.cache);
    expect(cached).toHaveLength(1);
    expect((cached[0] as { text: string }).text).toContain('[0:02] Click File.');
    expect(req.content.at(-1)!.cache).toBeFalsy();
    expect(req.outputSchema).toBe(INGEST_V1_SCHEMA);
    expect(req.system).toContain('in English');
  });

  it('video without narration says so', () => {
    const req = buildIngestVideoV1({
      title: '',
      frames: [],
      transcript: null,
      outputLanguage: 'English',
    });
    expect(JSON.stringify(req.content)).toContain('no narration');
  });

  it('document: sent as a cached document block', () => {
    const req = buildIngestDocV1({
      title: 'SOP',
      document: { mediaType: 'application/pdf', data: Buffer.from('%PDF') },
      outputLanguage: 'German',
    });
    expect(req.content[0]).toMatchObject({
      type: 'document',
      mediaType: 'application/pdf',
      cache: true,
    });
    expect(req.system).toContain('in German');
  });
});
