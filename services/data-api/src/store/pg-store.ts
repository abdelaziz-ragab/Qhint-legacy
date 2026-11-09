import { randomUUID } from 'node:crypto';
import { Procedure } from '@qhint/schema';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type {
  ContentDB,
  DocumentsTable,
  GapsTable,
  IngestJobsTable,
  ProceduresTable,
} from './db-types';
import type {
  DataPlaneStore,
  DocumentRecord,
  GapRecord,
  IngestJobRecord,
  NewProcedure,
  ProcedureScope,
  ProcedureSummary,
} from './store';
import { withTenant } from './tenant-tx';

const Body = z.object({
  apps: z.array(z.unknown()),
  variables: z.array(z.unknown()),
  steps: z.array(z.unknown()),
});

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function toProcedure(row: Selectable<ProceduresTable>): Procedure {
  const body = Body.parse(row.body);
  return Procedure.parse({
    id: row.id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    status: row.status,
    version: row.version,
    source: row.source,
    title: row.title,
    ...body,
  });
}

function toSummary(row: Selectable<ProceduresTable>): ProcedureSummary {
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    status: row.status,
    version: row.version,
    source: row.source,
    ownerId: row.owner_id,
    updatedAt: iso(row.updated_at),
  };
}

function toDocument(row: Selectable<DocumentsTable>): DocumentRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    ownerId: row.owner_id,
    createdAt: iso(row.created_at),
  };
}

function toJob(
  row: Selectable<IngestJobsTable>,
  doc: { title: string; kind: DocumentRecord['kind'] },
): IngestJobRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    title: doc.title,
    kind: doc.kind,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    language: row.language,
    outputLanguage: row.output_language,
    errorCode: row.error_code,
    procedureId: row.procedure_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Jobs with their upload's title and kind (both rows are under the same tenant policies). */
const jobsWithDocument = (trx: Transaction<ContentDB>) =>
  trx
    .selectFrom('content.ingest_jobs as j')
    .innerJoin('content.documents as d', (join) =>
      join.onRef('d.id', '=', 'j.document_id').onRef('d.tenant_id', '=', 'j.tenant_id'),
    )
    .selectAll('j')
    .select(['d.title as title', 'd.kind as kind']);

/** A claimed job is retried this many times before it is given up on. */
const MAX_ATTEMPTS = 3;
/** A worker that hasn't finished by then is presumed dead; the job can be claimed again. */
const LEASE = '15 minutes';

function toGap(row: Selectable<GapsTable>): GapRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    question: row.question,
    description: row.description,
    procedureId: row.procedure_id,
    stepId: row.step_id,
    userId: row.user_id,
    createdAt: iso(row.created_at),
  };
}

/** Postgres implementation; isolation is enforced by row-level security (see migrations). */
export class PgDataPlaneStore implements DataPlaneStore {
  constructor(private readonly db: Kysely<ContentDB>) {}

  procedures: DataPlaneStore['procedures'] = {
    list: (ctx, scope: ProcedureScope) =>
      withTenant(this.db, ctx, async (trx) => {
        let q = trx.selectFrom('content.procedures').selectAll();
        if (scope === 'mine') q = q.where('owner_id', '=', ctx.userId);
        if (scope === 'company') {
          q = q.where('visibility', '=', 'company').where('status', '=', 'published');
        }
        if (scope === 'review') q = q.where('status', '=', 'in_review');
        const rows = await q.orderBy('updated_at', 'desc').limit(200).execute();
        return rows.map(toSummary);
      }),

    get: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const row = await trx
          .selectFrom('content.procedures')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        return row ? toProcedure(row) : null;
      }),

    create: (ctx, input: NewProcedure) => {
      const id = randomUUID();
      // Validate the full procedure (step ids, variables, targets) before storing it.
      Procedure.parse({
        id,
        tenantId: ctx.tenantId,
        ownerId: ctx.userId,
        visibility: 'private',
        status: 'draft',
        version: 1,
        source: input.source,
        title: input.title,
        apps: input.apps,
        variables: input.variables,
        steps: input.steps,
      });
      return withTenant(this.db, ctx, async (trx) => {
        const row = await trx
          .insertInto('content.procedures')
          .values({
            id,
            tenant_id: ctx.tenantId,
            owner_id: ctx.userId,
            source: input.source,
            source_document_id: input.sourceDocumentId ?? null,
            title: input.title,
            body: JSON.stringify({
              apps: input.apps,
              variables: input.variables,
              steps: input.steps,
            }),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toProcedure(row);
      });
    },

    submitForReview: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const res = await trx
          .updateTable('content.procedures')
          .set({ status: 'in_review', updated_at: new Date() })
          .where('id', '=', id)
          .where('owner_id', '=', ctx.userId)
          .where('status', '=', 'draft')
          .executeTakeFirst();
        return res.numUpdatedRows > 0n;
      }),

    publish: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        if (ctx.role !== 'admin') return false;
        const res = await trx
          .updateTable('content.procedures')
          .set({ status: 'published', visibility: 'company', updated_at: new Date() })
          .where('id', '=', id)
          .where('status', '=', 'in_review')
          .executeTakeFirst();
        return res.numUpdatedRows > 0n;
      }),

    update: (ctx, id, edit) =>
      withTenant(this.db, ctx, async (trx) => {
        const row = await trx
          .selectFrom('content.procedures')
          .selectAll()
          .where('id', '=', id)
          .where('owner_id', '=', ctx.userId)
          .where('status', '=', 'draft')
          .forUpdate()
          .executeTakeFirst();
        if (!row) return null;
        const current = toProcedure(row);
        // Validate the whole edited procedure, not just the changed parts.
        const next = Procedure.parse({
          ...current,
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.variables !== undefined ? { variables: edit.variables } : {}),
          ...(edit.steps !== undefined ? { steps: edit.steps } : {}),
        });
        const updated = await trx
          .updateTable('content.procedures')
          .set({
            title: next.title,
            body: JSON.stringify({ apps: next.apps, variables: next.variables, steps: next.steps }),
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return toProcedure(updated);
      }),

    remove: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const res = await trx
          .deleteFrom('content.procedures')
          .where('id', '=', id)
          .where('owner_id', '=', ctx.userId)
          .where('status', '=', 'draft')
          .executeTakeFirst();
        return res.numDeletedRows > 0n;
      }),
  };

  documents: DataPlaneStore['documents'] = {
    create: (ctx, input) =>
      withTenant(this.db, ctx, async (trx) => {
        const id = randomUUID();
        const row = await trx
          .insertInto('content.documents')
          .values({
            id,
            tenant_id: ctx.tenantId,
            owner_id: ctx.userId,
            kind: input.kind,
            title: input.title,
            storage_key: `t/${ctx.tenantId}/${input.kind}/${id}`,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toDocument(row);
      }),

    get: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const row = await trx
          .selectFrom('content.documents')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        return row ? toDocument(row) : null;
      }),

    markUploaded: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const res = await trx
          .updateTable('content.documents')
          .set({ status: 'uploaded' })
          .where('id', '=', id)
          .where('owner_id', '=', ctx.userId)
          .where('status', '=', 'pending_upload')
          .executeTakeFirst();
        return res.numUpdatedRows > 0n;
      }),

    setStatus: (ctx, id, status) =>
      withTenant(this.db, ctx, async (trx) => {
        await trx.updateTable('content.documents').set({ status }).where('id', '=', id).execute();
      }),

    markSourceDeleted: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        await trx
          .updateTable('content.documents')
          .set({ source_deleted_at: new Date() })
          .where('id', '=', id)
          .execute();
      }),
  };

  ingest: DataPlaneStore['ingest'] = {
    create: (ctx, input) =>
      withTenant(this.db, ctx, async (trx) => {
        const doc = await trx
          .selectFrom('content.documents')
          .select(['id', 'kind', 'title'])
          .where('id', '=', input.documentId)
          .where('owner_id', '=', ctx.userId)
          .where('status', 'in', ['uploaded', 'failed'])
          .where('source_deleted_at', 'is', null)
          .executeTakeFirst();
        if (!doc || doc.kind === 'recording') return null;
        await trx
          .updateTable('content.documents')
          .set({ status: 'processing' })
          .where('id', '=', doc.id)
          .execute();
        const row = await trx
          .insertInto('content.ingest_jobs')
          .values({
            tenant_id: ctx.tenantId,
            owner_id: ctx.userId,
            document_id: doc.id,
            ...(input.language ? { language: input.language } : {}),
            ...(input.outputLanguage ? { output_language: input.outputLanguage } : {}),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toJob(row, { title: doc.title, kind: doc.kind });
      }),

    get: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const row = await jobsWithDocument(trx).where('j.id', '=', id).executeTakeFirst();
        return row ? toJob(row, row) : null;
      }),

    list: (ctx) =>
      withTenant(this.db, ctx, async (trx) => {
        const rows = await jobsWithDocument(trx)
          .orderBy('j.created_at', 'desc')
          .limit(100)
          .execute();
        return rows.map((r) => toJob(r, r));
      }),

    progress: (ctx, id, stage, progress) =>
      withTenant(this.db, ctx, async (trx) => {
        await trx
          .updateTable('content.ingest_jobs')
          .set({
            stage,
            progress: Math.max(0, Math.min(100, Math.round(progress))),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .where('status', '=', 'running')
          .execute();
      }),

    finish: (ctx, id, procedureId, report) =>
      withTenant(this.db, ctx, async (trx) => {
        const job = await trx
          .updateTable('content.ingest_jobs')
          .set({
            status: 'done',
            stage: 'done',
            progress: 100,
            procedure_id: procedureId,
            locked_until: null,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returning(['document_id'])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('content.ingest_reports')
          .values({
            job_id: id,
            tenant_id: ctx.tenantId,
            owner_id: ctx.userId,
            body: JSON.stringify(report),
          })
          .onConflict((oc) => oc.column('job_id').doUpdateSet({ body: JSON.stringify(report) }))
          .execute();
        await trx
          .updateTable('content.documents')
          .set({ status: 'ready' })
          .where('id', '=', job.document_id)
          .execute();
      }),

    fail: (ctx, id, errorCode) =>
      withTenant(this.db, ctx, async (trx) => {
        const job = await trx
          .updateTable('content.ingest_jobs')
          .set({
            status: 'failed',
            stage: 'failed',
            error_code: errorCode,
            locked_until: null,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returning(['document_id'])
          .executeTakeFirst();
        if (job) {
          await trx
            .updateTable('content.documents')
            .set({ status: 'failed' })
            .where('id', '=', job.document_id)
            .execute();
        }
      }),

    release: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        await trx
          .updateTable('content.ingest_jobs')
          .set({
            status: 'queued',
            stage: 'queued',
            progress: 0,
            locked_until: null,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .where('status', '=', 'running')
          .execute();
      }),

    report: (ctx, id) =>
      withTenant(this.db, ctx, async (trx) => {
        const row = await trx
          .selectFrom('content.ingest_reports')
          .select('body')
          .where('job_id', '=', id)
          .executeTakeFirst();
        return row?.body ?? null;
      }),

    // Runs with app.role = 'ingest_worker' and no tenant: the policies only show queued/running
    // jobs to that role, and only let it mark them running (claim) or failed (gave up).
    claim: () =>
      this.db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.role', 'ingest_worker', true)`.execute(trx);
        await trx
          .updateTable('content.ingest_jobs')
          .set({
            status: 'failed',
            stage: 'failed',
            error_code: 'too_many_attempts',
            locked_until: null,
          })
          .where('status', '=', 'running')
          .where('locked_until', '<', new Date())
          .where('attempts', '>=', MAX_ATTEMPTS)
          .execute();
        const res = await sql<{
          id: string;
          tenant_id: string;
          owner_id: string;
          document_id: string;
          language: string;
          output_language: string;
          attempts: number;
        }>`
          UPDATE content.ingest_jobs
             SET status = 'running', attempts = attempts + 1,
                 locked_until = now() + ${LEASE}::interval, updated_at = now()
           WHERE id = (
             SELECT id FROM content.ingest_jobs
              WHERE (status = 'queued' OR (status = 'running' AND locked_until < now()))
                AND attempts < ${MAX_ATTEMPTS}
              ORDER BY created_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1)
          RETURNING id, tenant_id, owner_id, document_id, language, output_language, attempts`.execute(
          trx,
        );
        const r = res.rows[0];
        return r
          ? {
              id: r.id,
              tenantId: r.tenant_id,
              ownerId: r.owner_id,
              documentId: r.document_id,
              language: r.language,
              outputLanguage: r.output_language,
              attempts: r.attempts,
            }
          : null;
      }),
  };

  gaps: DataPlaneStore['gaps'] = {
    create: (ctx, input) =>
      withTenant(this.db, ctx, async (trx) => {
        const row = await trx
          .insertInto('content.gaps')
          .values({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            kind: input.kind as GapsTable['kind'],
            question: input.question ?? null,
            description: input.description,
            procedure_id: input.procedureId ?? null,
            step_id: input.stepId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toGap(row);
      }),

    list: (ctx) =>
      withTenant(this.db, ctx, async (trx) => {
        const rows = await trx
          .selectFrom('content.gaps')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(500)
          .execute();
        return rows.map(toGap);
      }),
  };
}
