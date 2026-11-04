import { randomUUID } from 'node:crypto';
import { Procedure } from '@qhint/schema';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { ContentDB, DocumentsTable, GapsTable, ProceduresTable } from './db-types';
import type {
  DataPlaneStore,
  DocumentRecord,
  GapRecord,
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
