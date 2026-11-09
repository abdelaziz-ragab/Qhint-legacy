/**
 * Guides in the main process: listing, editing, creating from a video or document, running.
 * All network calls carry the user's token here; the renderer only ever sees results.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { Procedure } from '@qhint/schema';
import { z } from 'zod';
import {
  type CreateGuideRequest,
  type CreateGuideResult,
  type Guide,
  type GuideEdit,
  type GuideJob,
  type GuideLists,
  type GuideReport,
  type GuideSummary,
  type Result,
  type UploadProgress,
} from '../../shared/guides';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GuideServiceDeps {
  /** Authenticated fetch (adds the user's token). */
  fetch: Fetch;
  /** The tenant's data-api address, or null when signed out. */
  dataApiUrl: () => string | null;
}

const TYPES: Record<string, { contentType: string; kind: 'video' | 'doc'; maxBytes: number }> = {
  mp4: { contentType: 'video/mp4', kind: 'video', maxBytes: 1024 ** 3 },
  mov: { contentType: 'video/quicktime', kind: 'video', maxBytes: 1024 ** 3 },
  webm: { contentType: 'video/webm', kind: 'video', maxBytes: 1024 ** 3 },
  ogv: { contentType: 'video/ogg', kind: 'video', maxBytes: 1024 ** 3 },
  pdf: { contentType: 'application/pdf', kind: 'doc', maxBytes: 30 * 1024 ** 2 },
  txt: { contentType: 'text/plain', kind: 'doc', maxBytes: 30 * 1024 ** 2 },
  md: { contentType: 'text/markdown', kind: 'doc', maxBytes: 30 * 1024 ** 2 },
};

/** What kind of file this is, if Qhint can use it. */
export function sourceType(path: string) {
  return TYPES[extname(path).slice(1).toLowerCase()] ?? null;
}

const Summary = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'in_review', 'published']),
  visibility: z.enum(['private', 'company']),
  source: z.enum(['video', 'doc', 'recording', 'generated']),
  updatedAt: z.string(),
});
const Job = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['video', 'doc', 'recording']),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  stage: z.enum([
    'queued',
    'reading',
    'frames',
    'transcribing',
    'writing',
    'images',
    'saving',
    'done',
    'failed',
  ]),
  progress: z.number(),
  errorCode: z.string().nullable(),
  procedureId: z.string().nullable(),
  createdAt: z.string(),
});
const Report = z.object({
  summary: z.string().optional(),
  flagged: z
    .array(z.object({ stepId: z.string(), clarity: z.string(), note: z.string() }))
    .default([]),
  problems: z.array(z.string()).default([]),
});
const Upload = z.object({
  documentId: z.string(),
  upload: z.object({
    url: z.string(),
    method: z.enum(['PUT', 'POST']),
    headers: z.record(z.string(), z.string()),
  }),
});

export class GuideService {
  constructor(private readonly deps: GuideServiceDeps) {}

  async lists(): Promise<GuideLists> {
    const list = async (scope: 'mine' | 'company') =>
      z
        .object({ procedures: z.array(Summary) })
        .parse(await this.json('GET', `/procedures?scope=${scope}`)).procedures as GuideSummary[];
    const [mine, company] = await Promise.all([list('mine'), list('company')]);
    return { mine, company };
  }

  async get(id: string): Promise<Guide> {
    return Procedure.parse(await this.json('GET', `/procedures/${encodeURIComponent(id)}`));
  }

  async update(id: string, edit: GuideEdit): Promise<Result<Guide>> {
    const res = await this.call('PATCH', `/procedures/${encodeURIComponent(id)}`, edit);
    if (!res.ok) return { ok: false, error: res.status === 400 ? 'invalid' : `http_${res.status}` };
    return { ok: true, value: Procedure.parse(await res.json()) };
  }

  async remove(id: string): Promise<boolean> {
    return (await this.call('DELETE', `/procedures/${encodeURIComponent(id)}`)).ok;
  }

  async submit(id: string): Promise<boolean> {
    return (await this.call('POST', `/procedures/${encodeURIComponent(id)}/submit`)).ok;
  }

  async jobs(): Promise<GuideJob[]> {
    return z.object({ jobs: z.array(Job) }).parse(await this.json('GET', '/ingest')).jobs;
  }

  /** The review notes for a generated guide (null if it wasn't generated or isn't done). */
  async report(procedureId: string): Promise<GuideReport | null> {
    const job = (await this.jobs()).find(
      (j) => j.procedureId === procedureId && j.status === 'done',
    );
    if (!job) return null;
    const body = z
      .object({ report: Report.nullable() })
      .parse(await this.json('GET', `/ingest/${job.id}`));
    return body.report;
  }

  /** Upload a video or document and start turning it into a guide. */
  async create(
    req: CreateGuideRequest,
    onProgress: (p: UploadProgress) => void,
  ): Promise<CreateGuideResult> {
    const type = sourceType(req.path);
    if (!type) return { ok: false, error: 'unsupported_type' };
    const info = await stat(req.path).catch(() => null);
    if (!info?.isFile()) return { ok: false, error: 'not_a_file' };
    if (info.size === 0) return { ok: false, error: 'empty_file' };
    if (info.size > type.maxBytes) return { ok: false, error: 'too_large' };
    const title = req.title.trim().slice(0, 300) || basename(req.path, extname(req.path));

    // 1. Register the upload; the server answers with a short-lived upload address.
    const reg = await this.call('POST', '/uploads', {
      kind: type.kind,
      title,
      contentType: type.contentType,
      sizeBytes: info.size,
    });
    if (!reg.ok) return { ok: false, error: `register_${reg.status}` };
    const { documentId, upload } = Upload.parse(await reg.json());

    // 2. Send the file straight to storage (it never passes through our servers).
    let sent = 0;
    const counted = createReadStream(req.path).on('data', (chunk: string | Buffer) => {
      sent += chunk.length;
      onProgress({ path: req.path, sentBytes: sent, totalBytes: info.size });
    });
    const put = await fetch(upload.url, {
      method: upload.method,
      headers: { ...upload.headers, 'content-length': String(info.size) },
      body: Readable.toWeb(counted) as ReadableStream,
      duplex: 'half',
    } as RequestInit).catch(() => null);
    if (!put?.ok) return { ok: false, error: 'upload_failed' };

    // 3. Confirm, then start processing.
    const done = await this.call('POST', `/uploads/${documentId}/complete`);
    if (!done.ok) return { ok: false, error: 'upload_failed' };
    const job = await this.call('POST', '/ingest', {
      documentId,
      language: req.language,
      outputLanguage: req.outputLanguage,
    });
    if (!job.ok) return { ok: false, error: `ingest_${job.status}` };
    return { ok: true, job: Job.parse(await job.json()) };
  }

  private base(): string {
    const base = this.deps.dataApiUrl();
    if (!base) throw new Error('signed_out');
    return base;
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    return this.deps.fetch(`${this.base()}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
  }

  private async json(method: string, path: string): Promise<unknown> {
    const res = await this.call(method, path);
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.json();
  }
}

/** Fill in a guide's variables (e.g. the file to import) before running it. */
export function withVariables(guide: Guide, values: Record<string, string>): Guide {
  return {
    ...guide,
    steps: guide.steps.map((s) => {
      if (!s.input || typeof s.input === 'string') return s;
      const value = values[s.input.var]?.trim();
      if (!value) return s;
      // A typed value becomes literal text; a clicked target gets the value as its label.
      const target =
        s.target && s.action !== 'type' && !s.target.text ? { ...s.target, text: value } : s.target;
      return { ...s, input: value, ...(target ? { target } : {}) };
    }),
  };
}
