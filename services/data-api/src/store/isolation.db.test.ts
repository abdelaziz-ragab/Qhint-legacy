/**
 * Cross-tenant isolation, proven against a real Postgres with the real application roles.
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
import { withTenant } from './tenant-tx';

const HOST = process.env.TEST_DB_HOST ?? '127.0.0.1:5432';
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? `postgres://qhint:qhint_dev@${HOST}/qhint`;
const DATA_URL =
  process.env.TEST_DATA_DATABASE_URL ?? `postgres://qhint_data_app:qhint_data_dev@${HOST}/qhint`;
const CONTROL_URL =
  process.env.TEST_CONTROL_DATABASE_URL ??
  `postgres://qhint_control_app:qhint_control_dev@${HOST}/qhint`;

// Fresh tenants per run so tests never depend on leftover data.
const acme = randomUUID();
const globex = randomUUID();
const ctx = (tenantId: string, role: 'employee' | 'admin' = 'employee'): TenantContext => ({
  tenantId,
  userId: randomUUID(),
  role,
});
const acmeEmployee = ctx(acme);
const acmeColleague = ctx(acme);
const acmeAdmin = ctx(acme, 'admin');
const globexAdmin = ctx(globex, 'admin');
const globexEmployee = ctx(globex);

const sample = (title: string): NewProcedure => ({
  title,
  source: 'doc',
  apps: [{ name: 'ServiceNow', kind: 'web' }],
  variables: [],
  steps: [
    {
      id: 's1',
      instruction: 'Click "New request"',
      app: { name: 'ServiceNow', kind: 'web' },
      action: 'click',
      target: { description: 'New request button', neighbors: [] },
      optional: false,
    },
  ],
});

let db: Kysely<ContentDB>;
let store: PgDataPlaneStore;
let owner: pg.Client;

beforeAll(async () => {
  db = createDb<ContentDB>(DATA_URL, { max: 2 });
  store = new PgDataPlaneStore(db);
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
});

afterAll(async () => {
  for (const t of ['step_results', 'runs', 'gaps', 'procedures', 'documents']) {
    await owner.query(`DELETE FROM content.${t} WHERE tenant_id = ANY($1::uuid[])`, [
      [acme, globex],
    ]);
  }
  await owner.end();
  await db.destroy();
});

describe('tenant isolation (row-level security)', () => {
  it('another tenant cannot list or read a procedure, even as admin', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('Request Salesforce access'));
    expect(await store.procedures.get(acmeEmployee, p.id)).not.toBeNull();

    expect(await store.procedures.get(globexAdmin, p.id)).toBeNull();
    for (const scope of ['mine', 'company', 'review'] as const) {
      const list = await store.procedures.list(globexAdmin, scope);
      expect(list.map((x) => x.id)).not.toContain(p.id);
    }
  });

  it('published company procedures are visible within the tenant only', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('Reset VPN token'));
    expect(await store.procedures.submitForReview(acmeEmployee, p.id)).toBe(true);
    expect(await store.procedures.publish(acmeAdmin, p.id)).toBe(true);

    const colleague = await store.procedures.list(acmeColleague, 'company');
    expect(colleague.map((x) => x.id)).toContain(p.id);
    expect(await store.procedures.get(globexEmployee, p.id)).toBeNull();
  });

  it('a forged tenant_id on insert is rejected by the database', async () => {
    await expect(
      withTenant(db, acmeEmployee, (trx) =>
        trx
          .insertInto('content.procedures')
          .values({
            tenant_id: globex, // lying about the tenant
            owner_id: acmeEmployee.userId,
            source: 'doc',
            source_document_id: null,
            title: 'smuggled',
            body: JSON.stringify({ apps: [], variables: [], steps: [] }),
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move a row to another tenant with UPDATE', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('Move me'));
    await expect(
      withTenant(db, acmeEmployee, (trx) =>
        trx
          .updateTable('content.procedures')
          .set({ tenant_id: globex })
          .where('id', '=', p.id)
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cross-tenant UPDATE and DELETE silently affect nothing', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('Keep me'));
    const updated = await withTenant(db, globexAdmin, (trx) =>
      trx
        .updateTable('content.procedures')
        .set({ title: 'hacked' })
        .where('id', '=', p.id)
        .executeTakeFirst(),
    );
    const deleted = await withTenant(db, globexAdmin, (trx) =>
      trx.deleteFrom('content.procedures').where('id', '=', p.id).executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
    expect(deleted.numDeletedRows).toBe(0n);
    expect((await store.procedures.get(acmeEmployee, p.id))?.title).toBe('Keep me');
  });

  it('with no tenant set, nothing is readable or writable (fails closed)', async () => {
    await store.procedures.create(acmeEmployee, sample('Invisible without context'));
    const rows = await db.selectFrom('content.procedures').selectAll().execute();
    expect(rows).toEqual([]);
    await expect(
      db
        .insertInto('content.gaps')
        .values({
          tenant_id: acme,
          user_id: acmeEmployee.userId,
          kind: 'no_procedure',
          description: 'x',
        })
        .execute(),
    ).rejects.toThrow(/row-level security/);
  });

  it('tenant settings do not leak to the next request on a pooled connection', async () => {
    await withTenant(db, acmeEmployee, async () => {});
    const setting = await sql<{
      t: string | null;
    }>`SELECT current_setting('app.tenant_id', true) AS t`.execute(db);
    expect(setting.rows[0]?.t || null).toBeNull();
  });

  it('documents can only reference keys under the tenant prefix', async () => {
    const d = await store.documents.create(acmeEmployee, {
      kind: 'video',
      title: 'Loom',
      contentType: 'video/mp4',
      sizeBytes: 1000,
    });
    expect(d.storageKey).toBe(`t/${acme}/video/${d.id}`);
    await expect(
      withTenant(db, acmeEmployee, (trx) =>
        trx
          .insertInto('content.documents')
          .values({
            tenant_id: acme,
            owner_id: acmeEmployee.userId,
            kind: 'doc',
            title: 'x',
            storage_key: `t/${globex}/doc/x`,
            content_type: 'text/plain',
            size_bytes: 1,
          })
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
    expect(await store.documents.get(globexAdmin, d.id)).toBeNull();
  });

  it('cannot reference another tenant’s procedure from a run or gap', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('Acme only'));
    await expect(
      withTenant(db, globexEmployee, (trx) =>
        trx
          .insertInto('content.runs')
          .values({
            tenant_id: globex,
            user_id: globexEmployee.userId,
            procedure_id: p.id,
            procedure_version: 1,
            mode: 'guided',
            ended_at: null,
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      store.gaps.create(globexEmployee, {
        kind: 'vague_step',
        description: 'x',
        procedureId: p.id,
      }),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('within a tenant (privacy and roles)', () => {
  it('a colleague, and even an admin, cannot see a private draft', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('My private notes'));
    expect(await store.procedures.get(acmeColleague, p.id)).toBeNull();
    expect(await store.procedures.get(acmeAdmin, p.id)).toBeNull();
  });

  it('admins see submissions for review; employees cannot publish', async () => {
    const p = await store.procedures.create(acmeEmployee, sample('Suggest me'));
    await store.procedures.submitForReview(acmeEmployee, p.id);
    expect((await store.procedures.list(acmeAdmin, 'review')).map((x) => x.id)).toContain(p.id);

    expect(await store.procedures.publish(acmeEmployee, p.id)).toBe(false);
    await expect(
      withTenant(db, acmeEmployee, (trx) =>
        trx
          .updateTable('content.procedures')
          .set({ status: 'published', visibility: 'company' })
          .where('id', '=', p.id)
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('employees see only their own gaps; admins see the tenant’s gap log', async () => {
    const mine = await store.gaps.create(acmeEmployee, {
      kind: 'no_procedure',
      description: 'VPN',
      question: 'how do I get VPN?',
    });
    await store.gaps.create(acmeColleague, { kind: 'no_procedure', description: 'Payroll' });
    expect((await store.gaps.list(acmeEmployee)).map((g) => g.id)).toEqual([mine.id]);
    expect((await store.gaps.list(acmeAdmin)).length).toBeGreaterThanOrEqual(2);
    expect(await store.gaps.list(globexAdmin)).toEqual([]);
  });
});

describe('plane separation (database roles)', () => {
  it('the data-api role cannot read control tables', async () => {
    await expect(sql`SELECT * FROM control.tenants`.execute(db)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('the control-api role cannot read content tables', async () => {
    const control = new pg.Client({ connectionString: CONTROL_URL });
    await control.connect();
    try {
      await expect(control.query('SELECT * FROM content.procedures')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await control.end();
    }
  });

  it('the data-api role cannot switch off row-level security', async () => {
    await expect(
      sql`ALTER TABLE content.procedures DISABLE ROW LEVEL SECURITY`.execute(db),
    ).rejects.toThrow(/must be owner/);
    // With row_security off, a query that RLS would filter must error instead of returning rows.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL row_security = off`.execute(trx);
        return sql`SELECT * FROM content.procedures`.execute(trx);
      }),
    ).rejects.toThrow(/row-level security/);
  });
});
