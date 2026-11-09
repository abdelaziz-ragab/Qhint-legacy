import {
  AppCategory,
  BBox,
  GapKind,
  Id,
  LocalId,
  ProcedureApp,
  ProcedureSource,
  Step,
  Variable,
} from '@qhint/schema';
import {
  authOf,
  createServer,
  forbidden,
  HttpError,
  notFound,
  requireAuth,
  type TokenVerifier,
} from '@qhint/server-kit';
import { z } from 'zod';
import type { ModelGateway } from './gateway/gateway';
import { locate } from './locate';
import { verify } from './verify';
import type { DataPlaneResolver } from './plane';
import type { StorageProvider } from './storage';
import type { DataPlaneStore } from './store/store';

export const SERVICE_NAME = 'data-api';

/** What can be uploaded, and how big. */
export const UPLOAD_LIMITS = {
  video: {
    types: ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'],
    maxBytes: 1024 ** 3,
  },
  // Word documents come later (converted to text first); PDFs and text work now.
  doc: { types: ['application/pdf', 'text/plain', 'text/markdown'], maxBytes: 30 * 1024 ** 2 },
} as const;

export interface DataDeps {
  store: DataPlaneStore;
  verifier: TokenVerifier;
  planes: DataPlaneResolver;
  storage: StorageProvider;
  gateway: ModelGateway;
  logger?: boolean;
}

/** Locate requests carry screenshots: allow a bigger body on that route only. */
export const LOCATE_BODY_LIMIT = 16 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 4 * 1024 * 1024;

const Jpeg = z
  .string()
  .max(MAX_IMAGE_BASE64)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .transform((b64) => Buffer.from(b64, 'base64'))
  .refine((buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, {
    message: 'not a JPEG',
  });

const Screen = z.object({
  label: LocalId,
  width: z.int().min(16).max(4096),
  height: z.int().min(16).max(4096),
  jpeg: Jpeg,
});

const VerifyBody = z.object({
  step: Step,
  before: z.array(Screen).min(1).max(4),
  after: z.array(Screen).min(1).max(4),
  appCategory: AppCategory.optional(),
});

const LocateBody = z.object({
  variant: z.enum(['v1', 'cu']).default('v1'),
  /** Set when the user pressed "I'm stuck": skip straight to the stronger model. */
  escalate: z.boolean().default(false),
  screens: z
    .array(
      z.object({
        label: LocalId,
        width: z.int().min(16).max(4096),
        height: z.int().min(16).max(4096),
        jpeg: Jpeg,
      }),
    )
    .min(1)
    .max(4),
  step: Step,
  exemplar: z.object({ jpeg: Jpeg, bbox: BBox }).optional(),
  appCategory: AppCategory.optional(),
});

const ProcedureId = z.object({ id: Id });

const NewProcedureBody = z.object({
  title: z.string().min(1).max(300),
  source: ProcedureSource,
  sourceDocumentId: Id.optional(),
  apps: z.array(ProcedureApp).max(20).default([]),
  variables: z.array(Variable).max(50).default([]),
  steps: z.array(Step).min(1).max(200),
});

const UploadBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    title: z.string().min(1).max(300),
    contentType: z.enum(UPLOAD_LIMITS.video.types),
    sizeBytes: z.int().min(1).max(UPLOAD_LIMITS.video.maxBytes),
  }),
  z.object({
    kind: z.literal('doc'),
    title: z.string().min(1).max(300),
    contentType: z.enum(UPLOAD_LIMITS.doc.types),
    sizeBytes: z.int().min(1).max(UPLOAD_LIMITS.doc.maxBytes),
  }),
]);

const ProcedureEditBody = z
  .object({
    title: z.string().min(1).max(300).optional(),
    variables: z.array(Variable).max(50).optional(),
    steps: z.array(Step).min(1).max(200).optional(),
  })
  .refine((b) => b.title !== undefined || b.variables !== undefined || b.steps !== undefined, {
    message: 'nothing to change',
  });

const IngestBody = z.object({
  documentId: Id,
  /** Spoken language of a video (BCP-47), for transcription. */
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .optional(),
  /** Language to write the guide in. */
  outputLanguage: z
    .string()
    .regex(/^[\p{L} ()-]{2,40}$/u)
    .optional(),
});

const NewGapBody = z.object({
  kind: GapKind,
  question: z.string().max(2000).optional(),
  description: z.string().min(1).max(2000),
  procedureId: Id.optional(),
  stepId: z.string().max(64).optional(),
});

/**
 * Data plane: all customer content. Every route requires a provisioned user, and every content
 * access goes through the DataPlaneStore with the context from the verified token.
 */
export function buildApp(deps: DataDeps) {
  const app = createServer({ name: SERVICE_NAME, logger: deps.logger });
  const { store } = deps;

  const auth = requireAuth({
    verifier: deps.verifier,
    expectedFirebaseTenant: async (tenantId) =>
      (await deps.planes.resolve(tenantId))?.firebaseTenantId ?? null,
  });

  // ---------------------------------------------------------------- procedures

  app.get(
    '/procedures',
    {
      onRequest: auth,
      schema: {
        querystring: z.object({ scope: z.enum(['mine', 'company', 'review']).default('company') }),
      },
    },
    async (req) => {
      const ctx = authOf(req);
      if (req.query.scope === 'review' && ctx.role !== 'admin') throw forbidden();
      return { procedures: await store.procedures.list(ctx, req.query.scope) };
    },
  );

  app.get('/procedures/:id', { onRequest: auth, schema: { params: ProcedureId } }, async (req) => {
    const p = await store.procedures.get(authOf(req), req.params.id);
    if (!p) throw notFound();
    return p;
  });

  app.post(
    '/procedures',
    { onRequest: auth, schema: { body: NewProcedureBody } },
    async (req, reply) => {
      try {
        const p = await store.procedures.create(authOf(req), req.body);
        return reply.status(201).send(p);
      } catch (err) {
        if (err instanceof z.ZodError) throw new HttpError(400, 'invalid_procedure');
        throw err;
      }
    },
  );

  app.patch(
    '/procedures/:id',
    { onRequest: auth, schema: { params: ProcedureId, body: ProcedureEditBody } },
    async (req) => {
      try {
        const p = await store.procedures.update(authOf(req), req.params.id, req.body);
        if (!p) throw notFound();
        return p;
      } catch (err) {
        if (err instanceof z.ZodError) throw new HttpError(400, 'invalid_procedure');
        throw err;
      }
    },
  );

  app.delete(
    '/procedures/:id',
    { onRequest: auth, schema: { params: ProcedureId } },
    async (req, reply) => {
      const ctx = authOf(req);
      const procedure = await store.procedures.get(ctx, req.params.id);
      if (!(await store.procedures.remove(ctx, req.params.id))) throw notFound();
      // Its pictures go too (only keys under this tenant's own prefix, as always).
      const plane = await deps.planes.resolve(ctx.tenantId);
      const prefix = `t/${ctx.tenantId}/`;
      const keys = (procedure?.steps ?? [])
        .map((s) => s.target?.exemplar?.imageRef)
        .filter((k): k is string => !!k && k.startsWith(prefix));
      if (plane) {
        await Promise.all(keys.map((k) => deps.storage.remove(plane.bucket, k).catch(() => {})));
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/procedures/:id/submit',
    { onRequest: auth, schema: { params: ProcedureId } },
    async (req) => {
      if (!(await store.procedures.submitForReview(authOf(req), req.params.id))) throw notFound();
      return { status: 'in_review' as const };
    },
  );

  app.post(
    '/procedures/:id/publish',
    { onRequest: auth, schema: { params: ProcedureId } },
    async (req) => {
      const ctx = authOf(req);
      if (ctx.role !== 'admin') throw forbidden();
      if (!(await store.procedures.publish(ctx, req.params.id))) throw notFound();
      return { status: 'published' as const };
    },
  );

  // ---------------------------------------------------------------- uploads (signed URLs)

  app.post('/uploads', { onRequest: auth, schema: { body: UploadBody } }, async (req, reply) => {
    const ctx = authOf(req);
    const plane = await deps.planes.resolve(ctx.tenantId);
    if (!plane) throw forbidden('no_data_plane');
    const doc = await store.documents.create(ctx, req.body);
    const upload = await deps.storage.uploadUrl(plane.bucket, doc.storageKey, doc.contentType);
    return reply.status(201).send({ documentId: doc.id, upload });
  });

  app.post(
    '/uploads/:id/complete',
    { onRequest: auth, schema: { params: ProcedureId } },
    async (req) => {
      const ctx = authOf(req);
      const doc = await store.documents.get(ctx, req.params.id);
      if (!doc || doc.ownerId !== ctx.userId) throw notFound();
      // Only mark it uploaded once the file is really in storage.
      const plane = await deps.planes.resolve(ctx.tenantId);
      const size = plane ? await deps.storage.size(plane.bucket, doc.storageKey) : null;
      if (!size) throw new HttpError(409, 'upload_missing');
      if (!(await store.documents.markUploaded(ctx, req.params.id))) throw notFound();
      return { status: 'uploaded' as const };
    },
  );

  // ---------------------------------------------------------------- ingest (upload -> draft guide)

  app.post('/ingest', { onRequest: auth, schema: { body: IngestBody } }, async (req, reply) => {
    const job = await store.ingest.create(authOf(req), req.body);
    // Not theirs, not uploaded yet, already processed, or a type we can't process.
    if (!job) throw new HttpError(409, 'document_not_ready');
    return reply.status(201).send(job);
  });

  app.get('/ingest', { onRequest: auth }, async (req) => ({
    jobs: await store.ingest.list(authOf(req)),
  }));

  app.get('/ingest/:id', { onRequest: auth, schema: { params: ProcedureId } }, async (req) => {
    const ctx = authOf(req);
    const job = await store.ingest.get(ctx, req.params.id);
    if (!job) throw notFound();
    const report = job.status === 'done' ? await store.ingest.report(ctx, job.id) : null;
    return { ...job, report };
  });

  // ---------------------------------------------------------------- locate (screenshots in, box out)

  app.post(
    '/locate',
    { onRequest: auth, bodyLimit: LOCATE_BODY_LIMIT, schema: { body: LocateBody } },
    async (req) => {
      const ctx = authOf(req);
      const { screens, step, exemplar, variant, appCategory, escalate } = req.body;
      // Screenshots live only in this request's memory: never stored, never logged.
      const outcome = await locate(
        deps.gateway,
        { tenantId: ctx.tenantId, userId: ctx.userId, appCategory },
        { screens, step, ...(exemplar ? { exemplar } : {}) },
        variant,
        { escalate },
      );
      return outcome;
    },
  );

  app.post(
    '/verify',
    { onRequest: auth, bodyLimit: LOCATE_BODY_LIMIT, schema: { body: VerifyBody } },
    async (req) => {
      const ctx = authOf(req);
      const { step, before, after, appCategory } = req.body;
      // Like /locate: screenshots are used for this request only.
      return verify(
        deps.gateway,
        { tenantId: ctx.tenantId, userId: ctx.userId, appCategory },
        { step, before, after },
      );
    },
  );

  // ---------------------------------------------------------------- gaps

  app.get('/gaps', { onRequest: auth }, async (req) => ({
    gaps: await store.gaps.list(authOf(req)),
  }));

  app.post('/gaps', { onRequest: auth, schema: { body: NewGapBody } }, async (req, reply) =>
    reply.status(201).send(await store.gaps.create(authOf(req), req.body)),
  );

  return app;
}
