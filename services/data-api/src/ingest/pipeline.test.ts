/**
 * The whole ingest pipeline on a tiny generated video: real ffmpeg, a fake model, in-memory
 * storage and store. Skipped when ffmpeg isn't installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Procedure } from '@qhint/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultGatewayConfig } from '../gateway/config';
import { FakeModelProvider } from '../gateway/fake-provider';
import { ModelGateway } from '../gateway/gateway';
import type { StorageProvider } from '../storage';
import type { ClaimedJob, DataPlaneStore, NewProcedure } from '../store/store';
import { exemplarRegion, runIngestJob } from './pipeline';
import { FixedTranscriber, NoTranscriber } from './transcribe';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const TENANT = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000101';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const KEY = `t/${TENANT}/video/${DOC}`;

let dir: string;
let video: Buffer;

beforeAll(() => {
  if (!hasFfmpeg) return;
  dir = mkdtempSync(join(tmpdir(), 'qhint-test-'));
  const out = join(dir, 'clip.mp4');
  // Three still "screens", one second each: red, blue, green (two screen changes).
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x240:d=1:r=10',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:d=1:r=10',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=320x240:d=1:r=10',
    '-filter_complex',
    '[0][1][2]concat=n=3:v=1:a=0',
    '-c:v',
    'mpeg4',
    out,
  ]);
  video = readFileSync(out);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function memoryStorage(initial: Record<string, Buffer>) {
  const objects = new Map(Object.entries(initial));
  const storage: StorageProvider = {
    uploadUrl: async () => ({ url: '', method: 'PUT', headers: {}, expiresAt: '' }),
    downloadUrl: async () => ({ url: '', method: 'GET', headers: {}, expiresAt: '' }),
    read: async (_b, k) => {
      const v = objects.get(k);
      if (!v) throw new Error('missing');
      return v;
    },
    write: async (_b, k, d) => void objects.set(k, d),
    remove: async (_b, k) => void objects.delete(k),
    size: async (_b, k) => objects.get(k)?.length ?? null,
  };
  return { storage, objects };
}

function memoryStore() {
  const events: string[] = [];
  let created: NewProcedure | null = null;
  let finished: { procedureId: string; report: unknown } | null = null;
  let failed: string | null = null;
  const store = {
    documents: {
      get: async () => ({
        id: DOC,
        kind: 'video',
        title: 'Colours',
        storageKey: KEY,
        contentType: 'video/mp4',
        sizeBytes: 1,
        status: 'processing',
        ownerId: OWNER,
        createdAt: '',
      }),
      markSourceDeleted: async () => void events.push('source_deleted'),
    },
    procedures: {
      create: async (_ctx: unknown, input: NewProcedure) => {
        created = input;
        return { id: 'proc-1' } as Procedure;
      },
    },
    ingest: {
      progress: async (_c: unknown, _id: string, stage: string) => void events.push(stage),
      finish: async (_c: unknown, _id: string, procedureId: string, report: unknown) => {
        finished = { procedureId, report };
      },
      fail: async (_c: unknown, _id: string, code: string) => {
        failed = code;
      },
      release: async () => void events.push('released'),
    },
  } as unknown as DataPlaneStore;
  return {
    store,
    events,
    created: () => created as NewProcedure | null,
    finished: () => finished as { procedureId: string; report: Record<string, unknown> } | null,
    failed: () => failed,
  };
}

const job: ClaimedJob = {
  id: 'job-1',
  tenantId: TENANT,
  ownerId: OWNER,
  documentId: DOC,
  language: 'en-US',
  outputLanguage: 'English',
  attempts: 1,
};

const modelAnswer = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    verdict: 'ok',
    title: 'Change the colour',
    summary: 'Clicks through the colours.',
    apps: [{ name: 'Colour App', kind: 'native' }],
    variables: [],
    steps: [
      {
        instruction: 'Click Blue.',
        action: 'click',
        app_name: 'Colour App',
        target_text: 'Blue',
        target_role: 'button',
        target_description: 'The Blue button',
        neighbors: [],
        input_text: null,
        input_variable: null,
        expected_after: 'The screen is blue.',
        frame: 'f01',
        bbox: [100, 100, 160, 130],
        clarity: 'clear',
        note: null,
      },
    ],
    problems: [],
    ...o,
  });

function deps(
  answer: string | Error,
  transcriber = new NoTranscriber() as NoTranscriber | FixedTranscriber,
) {
  const { storage, objects } = memoryStorage({ [KEY]: video });
  const s = memoryStore();
  const provider = new FakeModelProvider(() => answer);
  const gateway = new ModelGateway(provider, defaultGatewayConfig('k'.repeat(32)), () => {});
  const planes = {
    resolve: async () => ({
      tenantId: TENANT,
      firebaseTenantId: 'x',
      endpoint: 'x',
      bucket: 'bucket',
      keyRef: 'v1',
      region: 'r',
    }),
  };
  return {
    deps: { store: s.store, storage, planes, gateway, transcriber },
    objects,
    provider,
    ...s,
  };
}

describe.skipIf(!hasFfmpeg)('runIngestJob (video)', () => {
  it('makes a draft guide with an example image, then deletes the upload', async () => {
    const t = deps(modelAnswer());
    await runIngestJob(t.deps, job);

    expect(t.failed()).toBeNull();
    expect(t.events).toEqual([
      'reading',
      'frames',
      'writing',
      'images',
      'saving',
      'source_deleted',
    ]);

    // The model saw the frames before each change (and the end state), in order.
    const call = t.provider.calls[0]!;
    expect(call.model).toBe('claude-sonnet-5-5');
    const images = call.request.content.filter((p) => p.type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(2);
    expect(images.length).toBeLessThanOrEqual(4);

    const proc = t.created()!;
    expect(proc).toMatchObject({
      title: 'Change the colour',
      source: 'video',
      sourceDocumentId: DOC,
    });
    const target = proc.steps[0]!.target!;
    expect(target.exemplar?.imageRef).toBe(`t/${TENANT}/exemplars/${DOC}/s1.jpg`);
    const crop = t.objects.get(target.exemplar!.imageRef)!;
    expect(crop.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    expect(t.finished()?.procedureId).toBe('proc-1');
    expect(t.finished()?.report).toMatchObject({ steps: 1, exemplars: 1, narrated: false });
    // Only the small example image remains; the uploaded video is gone.
    expect(t.objects.has(KEY)).toBe(false);
  });

  it('passes the narration to the model when there is one', async () => {
    // The generated clip has no audio track, so the transcriber is never asked.
    const t = deps(modelAnswer(), new FixedTranscriber([{ start: 0, end: 1, text: 'Click blue' }]));
    await runIngestJob(t.deps, job);
    expect(JSON.stringify(t.provider.calls[0]!.request.content)).toContain('no narration');
  });

  it('fails with no_procedure (and keeps the upload) when the video shows no task', async () => {
    const t = deps(modelAnswer({ verdict: 'not_a_procedure', steps: [] }));
    await runIngestJob(t.deps, job);
    expect(t.failed()).toBe('no_procedure');
    expect(t.objects.has(KEY)).toBe(true);
  });

  it('fails with invalid_output when the model answers nonsense', async () => {
    const t = deps('not json');
    await runIngestJob(t.deps, job);
    expect(t.failed()).toBe('invalid_output');
  });

  it('retries later when the model service is unavailable', async () => {
    const t = deps(new Error('service unavailable'));
    await runIngestJob(t.deps, job);
    expect(t.failed()).toBeNull();
    expect(t.events).toContain('released');
  });
});

describe('exemplarRegion', () => {
  it('takes a region a few times the target’s size, kept inside the frame', () => {
    expect(exemplarRegion([100, 100, 160, 130], 1280, 720)).toEqual({
      x: 10,
      y: 45,
      width: 240,
      height: 140,
    });
    // Near the corner: shifted to stay inside.
    expect(exemplarRegion([0, 0, 20, 10], 1280, 720)).toEqual({
      x: 0,
      y: 0,
      width: 240,
      height: 140,
    });
    // Small frames: never bigger than the frame.
    expect(exemplarRegion([10, 10, 50, 30], 200, 100)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });
});
