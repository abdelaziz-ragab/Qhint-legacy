/**
 * One ingest job: uploaded video or document -> draft procedure, private to its owner.
 *
 * Runs as the job's owner (normal tenant isolation). Video: key frames + transcript -> Sonnet
 * writes the steps -> small target images are cropped from the frames. The uploaded file is
 * deleted once the guide exists (only the small target images are kept). Logs carry codes only.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIngestDocV1,
  buildIngestVideoV1,
  type IngestDraft,
  type IngestFrame,
  interpretIngestV1,
  type TranscriptSegment,
} from '@qhint/prompts';
import type { Step } from '@qhint/schema';
import { InvalidOutput, type ModelGateway, parseStrictJson } from '../gateway/gateway';
import type { DataPlaneResolver } from '../plane';
import type { StorageProvider } from '../storage';
import type { ClaimedJob, DataPlaneStore, TenantContext } from '../store/store';
import { selectKeyframes } from './keyframes';
import { audioFlac, cropJpeg, frameAt, MediaError, probe, thumbnails } from './media';
import { CHUNK_SECONDS, type Transcriber, TranscribeError } from './transcribe';

export interface IngestDeps {
  store: DataPlaneStore;
  storage: StorageProvider;
  planes: DataPlaneResolver;
  gateway: ModelGateway;
  transcriber: Transcriber;
  /** Content-free operational log (codes, counts, timings). */
  log?: (msg: string, fields?: Record<string, string | number | boolean>) => void;
}

export const LIMITS = {
  videoBytes: 1024 * 1024 * 1024,
  docBytes: 30 * 1024 * 1024,
  videoSeconds: 30 * 60,
  maxFrames: 48,
};

/** A failure the job shouldn't be retried for (bad input), as opposed to a temporary one. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly permanent = true,
  ) {
    super(code);
  }
}

const DOC_TYPES: Record<string, 'application/pdf' | 'text/plain'> = {
  'application/pdf': 'application/pdf',
  'text/plain': 'text/plain',
  'text/markdown': 'text/plain',
};

export async function runIngestJob(deps: IngestDeps, job: ClaimedJob): Promise<void> {
  // The worker acts for the job's owner: their tenant, their user, no admin rights.
  const ctx: TenantContext = { tenantId: job.tenantId, userId: job.ownerId, role: 'employee' };
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'qhint-ingest-'));
  try {
    const doc = await deps.store.documents.get(ctx, job.documentId);
    if (!doc) throw new JobError('source_missing');
    const plane = await deps.planes.resolve(job.tenantId);
    if (!plane) throw new JobError('no_data_plane');
    const progress = (stage: Parameters<DataPlaneStore['ingest']['progress']>[2], pct: number) =>
      deps.store.ingest.progress(ctx, job.id, stage, pct);

    await progress('reading', 5);
    const size = await deps.storage.size(plane.bucket, doc.storageKey);
    if (size === null) throw new JobError('source_missing');
    const limit = doc.kind === 'video' ? LIMITS.videoBytes : LIMITS.docBytes;
    if (size > limit) throw new JobError('too_large');
    const bytes = await deps.storage.read(plane.bucket, doc.storageKey).catch(() => {
      throw new JobError('storage_read', false);
    });

    const caller = { tenantId: job.tenantId, userId: job.ownerId };
    let draft: IngestDraft;
    let frames: (IngestFrame & { jpeg: Buffer })[] = [];
    const report: Record<string, unknown> = {};

    if (doc.kind === 'video') {
      const file = join(dir, 'source');
      await writeFile(file, bytes);
      const info = await probe(file);
      if (info.duration > LIMITS.videoSeconds) throw new JobError('too_long');
      report.durationSeconds = Math.round(info.duration);

      await progress('frames', 15);
      const fps = info.duration > 600 ? 2 : 4;
      const times = selectKeyframes(await thumbnails(file, fps), {
        fps,
        maxFrames: LIMITS.maxFrames,
      });
      const longSide = times.length > 32 ? 1024 : 1280;
      frames = [];
      for (const [i, t] of times.entries()) {
        const f = await frameAt(file, t, longSide);
        frames.push({ id: `f${String(i + 1).padStart(2, '0')}`, t, ...f });
      }
      report.frames = frames.length;

      let transcript: TranscriptSegment[] | null = null;
      if (info.hasAudio && deps.transcriber.name !== 'none') {
        await progress('transcribing', 30);
        try {
          const chunks = [];
          for (let start = 0; start < info.duration; start += CHUNK_SECONDS) {
            const len = Math.min(CHUNK_SECONDS, info.duration - start);
            if (len < 0.5) break;
            chunks.push({ start, flac: await audioFlac(file, start, len) });
          }
          const segs = await deps.transcriber.transcribe(chunks, job.language);
          transcript = segs.length ? segs : null;
        } catch (e) {
          // Narration helps but isn't required: carry on from the frames alone.
          deps.log?.('ingest transcript skipped', {
            job: job.id,
            code: e instanceof TranscribeError || e instanceof MediaError ? e.code : 'error',
          });
        }
      }
      report.narrated = transcript !== null;

      await progress('writing', 45);
      const input = { title: doc.title, frames, transcript, outputLanguage: job.outputLanguage };
      draft = await write(deps, caller, buildIngestVideoV1(input), frames);
    } else {
      const mediaType = DOC_TYPES[doc.contentType];
      if (!mediaType) throw new JobError('unsupported_type');
      await progress('writing', 30);
      const input = {
        title: doc.title,
        document: { mediaType, data: bytes },
        outputLanguage: job.outputLanguage,
      };
      draft = await write(deps, caller, buildIngestDocV1(input), []);
    }

    if (draft.verdict === 'not_a_procedure' || draft.steps.length === 0) {
      throw new JobError('no_procedure');
    }

    // Small example images of each target, cut from the frame where the model saw it.
    await progress('images', 80);
    const steps: Step[] = draft.steps.map((s) => ({ ...s }));
    for (const sighting of draft.sightings) {
      const frame = frames.find((f) => f.id === sighting.frameId);
      const i = steps.findIndex((s) => s.id === sighting.stepId);
      const step = steps[i];
      if (!frame || !step?.target) continue;
      try {
        const crop = exemplarRegion(sighting.bbox, frame.width, frame.height);
        const image = await cropJpeg(frame.jpeg, crop);
        const key = `t/${job.tenantId}/exemplars/${doc.id}/${step.id}.jpg`;
        await deps.storage.write(plane.bucket, key, image.jpeg, 'image/jpeg');
        const [x1, y1, x2, y2] = sighting.bbox;
        steps[i] = {
          ...step,
          target: {
            ...step.target,
            exemplar: {
              imageRef: key,
              bbox: [x1 - crop.x, y1 - crop.y, x2 - crop.x, y2 - crop.y],
            },
          },
        };
      } catch {
        // An example image is a nice-to-have; the step works without it.
      }
    }

    await progress('saving', 92);
    const procedure = await deps.store.procedures.create(ctx, {
      title: draft.title,
      source: doc.kind === 'video' ? 'video' : 'doc',
      sourceDocumentId: doc.id,
      apps: draft.apps,
      variables: draft.variables,
      steps,
    });
    await deps.store.ingest.finish(ctx, job.id, procedure.id, {
      ...report,
      verdict: draft.verdict,
      summary: draft.summary,
      flagged: draft.flagged,
      problems: draft.problems,
      steps: steps.length,
      exemplars: steps.filter((s) => s.target?.exemplar).length,
    });

    // The guide exists: delete the uploaded file (only the small target images are kept).
    await deps.storage.remove(plane.bucket, doc.storageKey).catch(() => {});
    await deps.store.documents.markSourceDeleted(ctx, doc.id);
    deps.log?.('ingest done', {
      job: job.id,
      kind: doc.kind,
      steps: steps.length,
      frames: frames.length,
      ms: Date.now() - started,
    });
  } catch (e) {
    const code = errorCode(e);
    const permanent = !(e instanceof JobError) || e.permanent;
    deps.log?.('ingest failed', {
      job: job.id,
      code,
      attempt: job.attempts,
      ms: Date.now() - started,
    });
    if (!permanent && job.attempts < 3) await deps.store.ingest.release(ctx, job.id);
    else await deps.store.ingest.fail(ctx, job.id, code);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ask the model for the procedure; a temporary failure is retried by the queue. */
async function write(
  deps: IngestDeps,
  caller: { tenantId: string; userId: string },
  request: ReturnType<typeof buildIngestVideoV1>,
  frames: IngestFrame[],
): Promise<IngestDraft> {
  const res = await deps.gateway.call('ingest', caller, request, (r) => {
    let json: unknown;
    try {
      json = parseStrictJson(r.text);
    } catch {
      throw new InvalidOutput();
    }
    const draft = interpretIngestV1(json, frames);
    if (!draft) throw new InvalidOutput();
    return draft;
  });
  if (res.ok) return res.value;
  // An outage is worth retrying; a refusal or an unusable answer would just repeat.
  throw new JobError(res.code, res.code !== 'provider_error');
}

/** Region to save around a target: a few times its size, so its surroundings help recognise it. */
export function exemplarRegion(
  bbox: readonly [number, number, number, number],
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const [x1, y1, x2, y2] = bbox;
  const w = Math.min(width, Math.max(240, (x2 - x1) * 3));
  const h = Math.min(height, Math.max(140, (y2 - y1) * 3));
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const x = Math.round(Math.min(Math.max(0, cx - w / 2), width - w));
  const y = Math.round(Math.min(Math.max(0, cy - h / 2), height - h));
  return { x, y, width: Math.round(w), height: Math.round(h) };
}

function errorCode(e: unknown): string {
  if (e instanceof JobError) return e.code;
  if (e instanceof MediaError) return 'bad_media';
  if (e instanceof TranscribeError) return e.code.replace(/[^a-z_]/g, '_').slice(0, 40);
  return 'internal';
}
