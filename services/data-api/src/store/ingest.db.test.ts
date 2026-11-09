/**
 * Ingest jobs against a real Postgres: owners see only their own jobs and reports, and the
 * background worker can claim waiting jobs across tenants without seeing any content.
 * Requires: `pnpm infra:up && pnpm db:migrate`.
 */
import { randomUUID } from 'node:crypto';
import { createDb } from '@qhint/server-kit';
import { type Kysely, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentDB } from './db-types';
import { PgDataPlaneStore } from './pg-store';
import type { NewProcedure, TenantContext } from './store';

const HOST = process.env.TEST_DB_HOST ?? '127.0.0.1:5432';
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? `postgres://qhint:qhint_dev@${HOST}/qhint`;
const DATA_URL =
  process.env.TEST_DATA_DATABASE_URL ?? `postgres://qhint_data_app:qhint_data_dev@${HOST}/qhint`;

const acme = randomUUID();
const globex = randomUUID();
const user = (tenantId: string, role: 'employee' | 'admin' = 'employee'): TenantContext => ({
  tenantId,
  userId: randomUUID(),
  role,
});
const alice = user(acme);
const colleague = user(acme);
const acmeAdmin = user(acme, 'admin');
const globexAdmin = user(globex, 'admin');

const draft = (title: string): NewProcedure => ({
  title,
  source: 'video',
  apps: [{ name: 'LibreOffice Calc', kind: 'native' }],
  variables: [],
  steps: [
    {
      id: 's1',
      instruction: 'Open the File menu.',
      app: { name: 'LibreOffice Calc', kind: 'native' },
      action: 'click',
      target: { description: 'File menu', text: 'File', neighbors: [] },
      optional: false,
    },
  ],
});

let db: Kysely<ContentDB>;
let store: PgDataPlaneStore;
let owner: pg.Client;

async function uploadedVideo(ctx: TenantContext) {
  const doc = await store.documents.create(ctx, {
    kind: 'video',
    title: 'Import data',
    contentType: 'video/webm',
    sizeBytes: 1000,
  });
  await store.documents.markUploaded(ctx, doc.id);
  return doc;
}

/** Claim until our job comes up; put any unrelated waiting jobs (local dev data) back. */
async function claimOurs(jobId: string) {
  const others: string[] = [];
  try {
    for (let i = 0; i < 25; i++) {
      const c = await store.ingest.claim();
      if (!c) return null;
      if (c.id === jobId) return c;
      others.push(c.id);
    }
    return null;
  } finally {
    if (others.length) {
      await owner.query(
        `UPDATE content.ingest_jobs SET status = 'queued', attempts = attempts - 1, locked_until = NULL
          WHERE id = ANY($1::uuid[])`,
        [others],
      );
    }
  }
}

beforeAll(async () => {
  db = createDb<ContentDB>(DATA_URL, { max: 2 });
  store = new PgDataPlaneStore(db);
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});

afterAll(async () => {
  for (const t of ['ingest_reports', 'ingest_jobs', 'procedures', 'documents']) {
    await owner.query(`DELETE FROM content.${t} WHERE tenant_id = ANY($1::uuid[])`, [
      [acme, globex],
    ]);
  }
  await owner.end();
  await db.destroy();
});

describe('ingest jobs', () => {
  it('only the owner can queue a job for their uploaded document', async () => {
    const doc = await uploadedVideo(alice);
    expect(await store.ingest.create(colleague, { documentId: doc.id })).toBeNull();
    expect(await store.ingest.create(acmeAdmin, { documentId: doc.id })).toBeNull();
    expect(await store.ingest.create(globexAdmin, { documentId: doc.id })).toBeNull();

    const job = await store.ingest.create(alice, { documentId: doc.id, language: 'ta-IN' });
    expect(job).toMatchObject({ status: 'queued', stage: 'queued', language: 'ta-IN' });
    expect((await store.documents.get(alice, doc.id))?.status).toBe('processing');
    // A document is processed once: no second job while it's processing.
    expect(await store.ingest.create(alice, { documentId: doc.id })).toBeNull();
  });

  it('refuses documents that were never uploaded', async () => {
    const doc = await store.documents.create(alice, {
      kind: 'video',
      title: 'x',
      contentType: 'video/mp4',
      sizeBytes: 10,
    });
    expect(await store.ingest.create(alice, { documentId: doc.id })).toBeNull();
  });

  it('jobs and reports are invisible to colleagues, admins and other tenants', async () => {
    const doc = await uploadedVideo(alice);
    const job = (await store.ingest.create(alice, { documentId: doc.id }))!;
    for (const other of [colleague, acmeAdmin, globexAdmin]) {
      expect(await store.ingest.get(other, job.id)).toBeNull();
      expect((await store.ingest.list(other)).map((j) => j.id)).not.toContain(job.id);
    }
    // Updates by anyone else change nothing.
    await store.ingest.fail(globexAdmin, job.id, 'nope');
    expect((await store.ingest.get(alice, job.id))?.status).toBe('queued');
  });

  it('the worker claims a job (ids only), the owner finishes it, the report stays private', async () => {
    const doc = await uploadedVideo(alice);
    const job = (await store.ingest.create(alice, { documentId: doc.id }))!;

    const claimed = await claimOurs(job.id);
    expect(claimed).toEqual({
      id: job.id,
      tenantId: acme,
      ownerId: alice.userId,
      documentId: doc.id,
      language: 'en-US',
      outputLanguage: 'English',
      attempts: 1,
    });
    // Running now: nobody else can claim it.
    expect(await claimOurs(job.id)).toBeNull();

    await store.ingest.progress(alice, job.id, 'writing', 55);
    expect(await store.ingest.get(alice, job.id)).toMatchObject({ stage: 'writing', progress: 55 });

    const p = await store.procedures.create(alice, draft('Import a CSV file'));
    await store.ingest.finish(alice, job.id, p.id, { flagged: [{ stepId: 's1' }] });
    expect(await store.ingest.get(alice, job.id)).toMatchObject({
      status: 'done',
      progress: 100,
      procedureId: p.id,
    });
    expect(await store.ingest.report(alice, job.id)).toEqual({ flagged: [{ stepId: 's1' }] });
    expect(await store.ingest.report(colleague, job.id)).toBeNull();
    expect((await store.documents.get(alice, doc.id))?.status).toBe('ready');
  });

  it('a temporary failure puts the job back in the queue; a permanent one fails it', async () => {
    const doc = await uploadedVideo(alice);
    const job = (await store.ingest.create(alice, { documentId: doc.id }))!;
    await claimOurs(job.id);
    await store.ingest.release(alice, job.id);
    expect((await store.ingest.get(alice, job.id))?.status).toBe('queued');
    expect((await claimOurs(job.id))?.attempts).toBe(2);
    await store.ingest.fail(alice, job.id, 'too_long');
    expect(await store.ingest.get(alice, job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'too_long',
    });
    expect((await store.documents.get(alice, doc.id))?.status).toBe('failed');
  });

  it('error codes must be content-free codes', async () => {
    const doc = await uploadedVideo(alice);
    const job = (await store.ingest.create(alice, { documentId: doc.id }))!;
    await expect(store.ingest.fail(alice, job.id, 'Alice’s file: secret.mp4')).rejects.toThrow();
  });
});

describe('the worker role sees job state, never content', () => {
  async function workerQuery(query: string, tenant?: string) {
    return db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'ingest_worker', true)`.execute(trx);
      if (tenant) await sql`SELECT set_config('app.tenant_id', ${tenant}, true)`.execute(trx);
      return (await sql.raw(query).execute(trx)).rows;
    });
  }

  it('cannot read documents, procedures or reports', async () => {
    await uploadedVideo(alice);
    await store.procedures.create(alice, draft('Private'));
    for (const t of ['documents', 'procedures', 'ingest_reports', 'gaps']) {
      expect(await workerQuery(`SELECT * FROM content.${t}`)).toEqual([]);
    }
  });

  it('sees only waiting or running jobs, and cannot mark one done', async () => {
    const doc = await uploadedVideo(alice);
    const job = (await store.ingest.create(alice, { documentId: doc.id }))!;
    const rows = (await workerQuery(`SELECT id, status FROM content.ingest_jobs`)) as {
      id: string;
      status: string;
    }[];
    expect(rows.every((r) => r.status === 'queued' || r.status === 'running')).toBe(true);
    expect(rows.map((r) => r.id)).toContain(job.id);
    await expect(
      workerQuery(`UPDATE content.ingest_jobs SET status = 'done' WHERE id = '${job.id}'`),
    ).rejects.toThrow(/row-level security/);
  });

  it('pretending to be the worker while a tenant is set gives no extra access', async () => {
    const doc = await uploadedVideo(alice);
    await store.ingest.create(alice, { documentId: doc.id });
    // A tenant context plus the worker role: is_ingest_worker() is false, so only owner rules apply.
    expect(await workerQuery(`SELECT * FROM content.ingest_jobs`, globex)).toEqual([]);
  });
});

describe('editing drafts', () => {
  it('the owner edits and deletes their draft; nobody else can', async () => {
    const p = await store.procedures.create(alice, draft('Import data'));
    expect(await store.procedures.update(colleague, p.id, { title: 'hijack' })).toBeNull();
    expect(await store.procedures.update(globexAdmin, p.id, { title: 'hijack' })).toBeNull();
    const edited = await store.procedures.update(alice, p.id, { title: 'Import a CSV file' });
    expect(edited).toMatchObject({ title: 'Import a CSV file', version: 2 });
    expect(await store.procedures.remove(colleague, p.id)).toBe(false);
    expect(await store.procedures.remove(alice, p.id)).toBe(true);
    expect(await store.procedures.get(alice, p.id)).toBeNull();
  });

  it('rejects edits that would make the procedure invalid', async () => {
    const p = await store.procedures.create(alice, draft('Import data'));
    const bad = [{ ...draft('x').steps[0]!, target: undefined }];
    await expect(store.procedures.update(alice, p.id, { steps: bad })).rejects.toThrow();
  });

  it('a submitted guide can no longer be edited as a draft', async () => {
    const p = await store.procedures.create(alice, draft('Import data'));
    await store.procedures.submitForReview(alice, p.id);
    expect(await store.procedures.update(alice, p.id, { title: 'late edit' })).toBeNull();
  });
});
