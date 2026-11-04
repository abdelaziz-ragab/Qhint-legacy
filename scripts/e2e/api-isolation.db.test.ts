/**
 * End-to-end isolation over HTTP: both services in-process, real Identity Platform tokens from the
 * Auth emulator, the real database through the restricted roles.
 * Requires: `pnpm infra:up && pnpm db:setup`.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createDb, FirebaseTokenVerifier, StaticTokenInternalAuth } from '@qhint/server-kit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp as buildControl } from '../../services/control-api/src/app';
import { PgControlStore } from '../../services/control-api/src/control-store';
import type { ControlDB } from '../../services/control-api/src/db/types';
import { PgEventSink } from '../../services/control-api/src/events';
import { FirebaseIdentityAdmin } from '../../services/control-api/src/identity';
import { buildApp as buildData } from '../../services/data-api/src/app';
import { HttpDataPlaneResolver } from '../../services/data-api/src/plane';
import { EmulatorStorage } from '../../services/data-api/src/storage';
import type { ContentDB } from '../../services/data-api/src/store/db-types';
import { PgDataPlaneStore } from '../../services/data-api/src/store/pg-store';

const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const STORAGE = process.env.STORAGE_EMULATOR_HOST ?? 'http://127.0.0.1:4443';
const DB_HOST = process.env.TEST_DB_HOST ?? '127.0.0.1:5432';
const PROJECT = 'demo-qhint';
const PASSWORD = 'qhint-dev-only';
const INTERNAL = new StaticTokenInternalAuth('e2e-internal-token-local-only-0000000000');
const ACME = '00000000-0000-4000-8000-000000000001';
const GLOBEX = '00000000-0000-4000-8000-000000000002';

let controlUrl = '';
let dataUrl = '';
const closers: (() => Promise<unknown>)[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
const created: string[] = [];
const tokens: Record<string, string> = {};

/** firebase-admin against the Auth emulator (loaded lazily so it never sees real Google). */
async function adminAuth() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR;
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(initializeApp({ projectId: PROJECT }, `e2e-${randomUUID()}`));
}

interface Discovery {
  firebaseTenantId: string;
  tenantName: string;
  methods: { password: boolean; google: boolean; microsoft: boolean; sso: unknown };
}

async function discover(email: string): Promise<{ status: number; body: Discovery }> {
  const res = await fetch(`${controlUrl}/auth/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: (await res.json()) as Discovery };
}

async function signIn(email: string): Promise<string> {
  const { firebaseTenantId } = (await discover(email)).body;
  const res = await fetch(
    `http://${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        tenantId: firebaseTenantId,
        returnSecureToken: true,
      }),
    },
  );
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`emulator sign-in failed for ${email} (run pnpm db:seed)`);
  const session = await fetch(`${controlUrl}/auth/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${body.idToken}` },
  });
  expect(session.status).toBe(200);
  return body.idToken;
}

/** A throwaway invited user (never the seeded google.user@… accounts people test with). */
async function inviteThrowaway(): Promise<{ userId: string; email: string; owner: pg.Client }> {
  const userId = randomUUID();
  const email = `e2e-${userId.slice(0, 8)}@acme.test`;
  const owner = new pg.Client({ connectionString: `postgres://qhint:qhint_dev@${DB_HOST}/qhint` });
  await owner.connect();
  await owner.query(
    `INSERT INTO control.users (id, tenant_id, firebase_uid, email, role) VALUES ($1, $2, NULL, $3, 'employee')`,
    [userId, ACME, email],
  );
  cleanups.push(async () => {
    await owner.query('DELETE FROM control.users WHERE id = $1', [userId]);
    await owner.end();
  });
  return { userId, email, owner };
}

/**
 * Google sign-in through the emulator, which accepts an unsigned fake Google identity (what its
 * fake Google page produces). No tenantId = project level.
 */
async function googleSignIn(
  fakeGoogle: string,
  tenantId?: string,
): Promise<{ idToken: string; refreshToken: string; localId: string }> {
  const res = await fetch(
    `http://${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestUri: 'http://localhost',
        postBody: `providerId=google.com&id_token=${encodeURIComponent(fakeGoogle)}`,
        ...(tenantId ? { tenantId } : {}),
        returnSecureToken: true,
      }),
    },
  );
  const body = (await res.json()) as { idToken: string; refreshToken: string; localId: string };
  expect(body.idToken).toBeTruthy();
  return body;
}

async function refresh(refreshToken: string): Promise<string> {
  const res = await fetch(
    `http://${EMULATOR}/securetoken.googleapis.com/v1/token?key=demo-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    },
  );
  return ((await res.json()) as { id_token: string }).id_token;
}

async function session(idToken: string) {
  const res = await fetch(`${controlUrl}/auth/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}` },
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function api(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${dataUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const procedure = (title: string) => ({
  title,
  source: 'doc',
  apps: [{ name: 'ServiceNow', kind: 'web' }],
  steps: [
    {
      id: 's1',
      instruction: 'Click "New request"',
      app: { name: 'ServiceNow', kind: 'web' },
      action: 'click',
      target: { description: 'New request button' },
    },
  ],
});

beforeAll(async () => {
  const verifier = () =>
    new FirebaseTokenVerifier({ projectId: PROJECT, emulatorHost: EMULATOR, production: false });

  const controlStore = new PgControlStore(
    createDb<ControlDB>(`postgres://qhint_control_app:qhint_control_dev@${DB_HOST}/qhint`, {
      max: 2,
    }),
  );
  const control = buildControl({
    store: controlStore,
    verifier: verifier(),
    identity: new FirebaseIdentityAdmin(PROJECT),
    internal: INTERNAL,
    events: new PgEventSink(controlStore),
    login: {
      apiKey: 'demo-api-key',
      authDomain: 'x',
      projectId: PROJECT,
      emulatorUrl: `http://${EMULATOR}`,
    },
  });
  await control.listen({ port: 0, host: '127.0.0.1' });
  controlUrl = `http://127.0.0.1:${(control.server.address() as AddressInfo).port}`;
  closers.push(() => control.close());

  const data = buildData({
    store: new PgDataPlaneStore(
      createDb<ContentDB>(`postgres://qhint_data_app:qhint_data_dev@${DB_HOST}/qhint`, { max: 2 }),
    ),
    verifier: verifier(),
    planes: new HttpDataPlaneResolver(controlUrl, INTERNAL),
    storage: new EmulatorStorage(STORAGE),
  });
  await data.listen({ port: 0, host: '127.0.0.1' });
  dataUrl = `http://127.0.0.1:${(data.server.address() as AddressInfo).port}`;
  closers.push(() => data.close());

  for (const email of [
    'employee@acme.test',
    'admin@acme.test',
    'admin@globex.test',
    'employee@globex.test',
  ]) {
    tokens[email] = await signIn(email);
  }
});

afterAll(async () => {
  for (const c of cleanups) await c();
  const owner = new pg.Client({ connectionString: `postgres://qhint:qhint_dev@${DB_HOST}/qhint` });
  await owner.connect();
  await owner.query(
    'DELETE FROM content.gaps WHERE procedure_id = ANY($1::uuid[]) OR description LIKE $2',
    [created, 'e2e:%'],
  );
  await owner.query('DELETE FROM content.procedures WHERE id = ANY($1::uuid[])', [created]);
  await owner.query('DELETE FROM content.documents WHERE title LIKE $1', ['e2e:%']);
  await owner.end();
  for (const close of closers.reverse()) await close();
});

describe('sign-in discovery and email + password', () => {
  it('reports the company and its sign-in methods', async () => {
    const res = await discover('employee@acme.test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantName: 'Acme (dev)',
      methods: { password: true, google: true, microsoft: false, sso: null },
    });
    expect(res.body.firebaseTenantId).toBeTruthy();
    expect((await discover('nobody@example.com')).status).toBe(404);
  });

  it('password sign-in to the company’s tenant yields a provisioned token', async () => {
    const token = await signIn('admin@acme.test');
    const me = await fetch(`${controlUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ tenantId: ACME, role: 'admin' });
  });
});

describe('first sign-in with Google (invited user)', () => {
  it('links the account, sets claims, and grants access only to that company', async () => {
    // A throwaway invited user per run (never the seeded google.user@… accounts people test with).
    const userId = randomUUID();
    const email = `e2e-${userId.slice(0, 8)}@acme.test`;
    const owner = new pg.Client({
      connectionString: `postgres://qhint:qhint_dev@${DB_HOST}/qhint`,
    });
    await owner.connect();
    await owner.query(
      `INSERT INTO control.users (id, tenant_id, firebase_uid, email, role) VALUES ($1, $2, NULL, $3, 'employee')`,
      [userId, ACME, email],
    );
    cleanups.push(async () => {
      await owner.query('DELETE FROM control.users WHERE id = $1', [userId]);
      await owner.end();
    });

    const { firebaseTenantId } = (await discover(email)).body;

    // The emulator accepts an unsigned fake Google identity (what its fake Google page produces).
    const fakeGoogle = JSON.stringify({ sub: `g-${randomUUID()}`, email, email_verified: true });
    const signIn = await fetch(
      `http://${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-api-key`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestUri: 'http://localhost',
          postBody: `providerId=google.com&id_token=${encodeURIComponent(fakeGoogle)}`,
          tenantId: firebaseTenantId,
          returnSecureToken: true,
          returnIdpCredential: true,
        }),
      },
    );
    const first = (await signIn.json()) as {
      idToken: string;
      refreshToken: string;
      localId: string;
    };
    expect(first.idToken).toBeTruthy();
    // Delete this run's throwaway account (and its fake Google identity) so it doesn't pile up in
    // the emulator's account picker. Only this uid, never a seeded account.
    cleanups.push(async () => {
      const admin = await adminAuth();
      await admin.tenantManager().authForTenant(firebaseTenantId).deleteUser(first.localId);
    });

    // Before linking: no claims, so data-api refuses.
    tokens.newcomer = first.idToken;
    expect((await api('newcomer', 'GET', '/procedures')).status).toBe(403);

    const session = await fetch(`${controlUrl}/auth/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.idToken}` },
    });
    expect(await session.json()).toMatchObject({ status: 'refresh', role: 'employee' });

    // Refresh to pick up the claims (what the sign-in page does).
    const refreshed = await fetch(
      `http://${EMULATOR}/securetoken.googleapis.com/v1/token?key=demo-api-key`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: first.refreshToken,
        }),
      },
    );
    tokens.newcomer = ((await refreshed.json()) as { id_token: string }).id_token;
    const me = await fetch(`${controlUrl}/me`, {
      headers: { authorization: `Bearer ${tokens.newcomer}` },
    });
    expect(await me.json()).toMatchObject({ tenantId: ACME, role: 'employee' });
    expect((await api('newcomer', 'GET', '/procedures?scope=company')).status).toBe(200);
  });
});

describe('Continue with Google without typing an email (project-level step, then tenant)', () => {
  it('the project-level token gets nothing; the same credential in the tenant gets access', async () => {
    const { email } = await inviteThrowaway();
    const fakeGoogle = JSON.stringify({ sub: `g-${randomUUID()}`, email, email_verified: true });

    // Step 1: Google at the project level (no tenant), only to learn the email.
    const project = await googleSignIn(fakeGoogle);
    cleanups.push(async () => (await adminAuth()).deleteUser(project.localId).catch(() => {}));
    tokens.projectLevel = project.idToken;
    const refused = await api('projectLevel', 'GET', '/procedures');
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: { code: 'not_provisioned' } });
    const me = await fetch(`${controlUrl}/me`, {
      headers: { authorization: `Bearer ${project.idToken}` },
    });
    expect(me.status).toBe(403);

    // The page deletes the temporary project-level account, then finds the company.
    await (await adminAuth()).deleteUser(project.localId);
    const { firebaseTenantId } = (await discover(email)).body;

    // Step 2: the same Google credential into the company's tenant (signInWithCredential).
    const tenant = await googleSignIn(fakeGoogle, firebaseTenantId);
    cleanups.push(async () =>
      (await adminAuth())
        .tenantManager()
        .authForTenant(firebaseTenantId)
        .deleteUser(tenant.localId),
    );
    const linked = await session(tenant.idToken);
    expect(linked.status).toBe(200);
    expect(linked.json).toMatchObject({ status: 'refresh', role: 'employee' });

    tokens.viaProject = await refresh(tenant.refreshToken);
    expect((await api('viaProject', 'GET', '/procedures?scope=company')).status).toBe(200);
  });

  it('claims are only ever granted inside a tenant: a project-level token can’t open a session', async () => {
    const { userId, email, owner } = await inviteThrowaway();
    const fakeGoogle = JSON.stringify({ sub: `g-${randomUUID()}`, email, email_verified: true });
    const project = await googleSignIn(fakeGoogle);
    cleanups.push(async () => (await adminAuth()).deleteUser(project.localId).catch(() => {}));

    const res = await session(project.idToken);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: { code: 'not_provisioned' } });

    // Nothing was linked or granted.
    const row = await owner.query('SELECT firebase_uid FROM control.users WHERE id = $1', [userId]);
    expect(row.rows[0].firebase_uid).toBeNull();
    const user = await (await adminAuth()).getUser(project.localId);
    expect(user.customClaims ?? {}).toEqual({});
  });
});

describe('API isolation with real sign-ins', () => {
  it('rejects requests without a token', async () => {
    const res = await fetch(`${dataUrl}/procedures`);
    expect(res.status).toBe(401);
  });

  it('Globex cannot read or list an Acme procedure', async () => {
    const made = await api(
      'employee@acme.test',
      'POST',
      '/procedures',
      procedure('e2e: Acme access request'),
    );
    expect(made.status).toBe(201);
    created.push(made.json.id);
    expect(made.json.tenantId).toBe(ACME);

    expect((await api('employee@acme.test', 'GET', `/procedures/${made.json.id}`)).status).toBe(
      200,
    );
    expect((await api('admin@globex.test', 'GET', `/procedures/${made.json.id}`)).status).toBe(404);
    for (const scope of ['mine', 'company', 'review']) {
      const list = await api('admin@globex.test', 'GET', `/procedures?scope=${scope}`);
      expect(list.json.procedures.map((p: { id: string }) => p.id)).not.toContain(made.json.id);
    }
  });

  it('a tenantId in the body is ignored: content lands in the caller’s tenant', async () => {
    const made = await api('admin@globex.test', 'POST', '/procedures', {
      ...procedure('e2e: smuggle attempt'),
      tenantId: ACME,
    });
    expect(made.status).toBe(201);
    created.push(made.json.id);
    expect(made.json.tenantId).toBe(GLOBEX);
    expect((await api('employee@acme.test', 'GET', `/procedures/${made.json.id}`)).status).toBe(
      404,
    );
  });

  it('publishing makes a procedure visible to the same company only', async () => {
    const made = await api(
      'employee@acme.test',
      'POST',
      '/procedures',
      procedure('e2e: Reset VPN'),
    );
    created.push(made.json.id);
    expect((await api('admin@acme.test', 'GET', `/procedures/${made.json.id}`)).status).toBe(404); // private draft
    expect(
      (await api('employee@acme.test', 'POST', `/procedures/${made.json.id}/submit`)).status,
    ).toBe(200);
    expect(
      (await api('employee@acme.test', 'POST', `/procedures/${made.json.id}/publish`)).status,
    ).toBe(403);
    expect(
      (await api('admin@globex.test', 'POST', `/procedures/${made.json.id}/publish`)).status,
    ).toBe(404);
    expect(
      (await api('admin@acme.test', 'POST', `/procedures/${made.json.id}/publish`)).status,
    ).toBe(200);

    const acme = await api('admin@acme.test', 'GET', '/procedures?scope=company');
    expect(acme.json.procedures.map((p: { id: string }) => p.id)).toContain(made.json.id);
    const globex = await api('employee@globex.test', 'GET', '/procedures?scope=company');
    expect(globex.json.procedures.map((p: { id: string }) => p.id)).not.toContain(made.json.id);
  });

  it('upload URLs are scoped to the caller’s tenant prefix and work end to end', async () => {
    const res = await api('employee@acme.test', 'POST', '/uploads', {
      kind: 'doc',
      title: 'e2e: SOP',
      contentType: 'text/plain',
      sizeBytes: 11,
    });
    expect(res.status).toBe(201);
    expect(decodeURIComponent(res.json.upload.url)).toContain(`name=t/${ACME}/doc/`);
    const put = await fetch(res.json.upload.url, {
      method: 'POST',
      headers: res.json.upload.headers,
      body: 'hello world',
    });
    expect(put.ok).toBe(true);
    expect(
      (await api('admin@globex.test', 'POST', `/uploads/${res.json.documentId}/complete`)).status,
    ).toBe(404);
    expect(
      (await api('employee@acme.test', 'POST', `/uploads/${res.json.documentId}/complete`)).status,
    ).toBe(200);
  });

  it('gap logs are per company', async () => {
    const gap = await api('employee@acme.test', 'POST', '/gaps', {
      kind: 'no_procedure',
      question: 'how do I order a monitor?',
      description: 'e2e: no procedure for monitor orders',
    });
    expect(gap.status).toBe(201);
    const globexGaps = await api('admin@globex.test', 'GET', '/gaps');
    expect(globexGaps.json.gaps.map((g: { id: string }) => g.id)).not.toContain(gap.json.id);
    const acmeGaps = await api('admin@acme.test', 'GET', '/gaps');
    expect(acmeGaps.json.gaps.map((g: { id: string }) => g.id)).toContain(gap.json.id);
  });

  it('claims for another company are refused (token tenant ≠ claimed tenant)', async () => {
    // Simulate a bug or tampering: a Globex user whose claims point at Acme.
    const admin = await adminAuth();
    const globexIdp = (await discover('x@globex.test')).body;
    const tenantAuth = admin.tenantManager().authForTenant(globexIdp.firebaseTenantId);
    const uid = `e2e-${randomUUID()}`;
    const email = `${uid}@globex.test`;
    await tenantAuth.createUser({ uid, email, password: PASSWORD, emailVerified: true });
    await tenantAuth.setCustomUserClaims(uid, {
      tenantId: ACME,
      userId: randomUUID(),
      role: 'admin',
    });
    try {
      const res = await fetch(
        `http://${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email,
            password: PASSWORD,
            tenantId: globexIdp.firebaseTenantId,
            returnSecureToken: true,
          }),
        },
      );
      tokens.forged = ((await res.json()) as { idToken: string }).idToken;
      const out = await api('forged', 'GET', '/procedures?scope=company');
      expect(out.status).toBe(403);
      expect(out.json).toEqual({ error: { code: 'tenant_mismatch' } });
    } finally {
      await tenantAuth.deleteUser(uid);
    }
  });
});
