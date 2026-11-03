/**
 * Local dev seed: one tenant ("acme-dev") with one admin and one employee, in Postgres and in
 * the Firebase Auth emulator (as an Identity Platform tenant), plus the content bucket in the
 * storage stub. Idempotent; safe to run on every `pnpm dev`. Refuses non-local targets.
 */
import pg from 'pg';
import { assertLocal, DEV } from './lib/dev-env';

assertLocal('DATABASE_URL', DEV.databaseUrl);
assertLocal('FIREBASE_AUTH_EMULATOR_HOST', DEV.authEmulatorHost);
assertLocal('STORAGE_EMULATOR_HOST', DEV.storageEmulatorHost);
// Must be set before firebase-admin is loaded so it never talks to real Google endpoints.
process.env.FIREBASE_AUTH_EMULATOR_HOST = DEV.authEmulatorHost;

const { initializeApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');

const TENANT = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Acme (dev)',
  firebaseDisplayName: 'acme-dev',
  emailDomains: ['acme.test'],
};

const USERS = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    uid: 'dev-acme-admin',
    email: 'admin@acme.test',
    role: 'admin',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    uid: 'dev-acme-employee',
    email: 'employee@acme.test',
    role: 'employee',
  },
] as const;

/** Emulator-only password so you can sign in locally without email links. */
const DEV_PASSWORD = 'qhint-dev-only';

async function seedAuth() {
  const app = initializeApp({ projectId: DEV.firebaseProjectId }, 'seed');
  const tm = getAuth(app).tenantManager();

  const { tenants } = await tm.listTenants();
  const tenant =
    tenants.find((t) => t.displayName === TENANT.firebaseDisplayName) ??
    (await tm.createTenant({
      displayName: TENANT.firebaseDisplayName,
      emailSignInConfig: { enabled: true, passwordRequired: false },
    }));

  const auth = tm.authForTenant(tenant.tenantId);
  for (const u of USERS) {
    const props = { email: u.email, password: DEV_PASSWORD, emailVerified: true };
    try {
      await auth.updateUser(u.uid, props);
    } catch {
      await auth.createUser({ uid: u.uid, ...props });
    }
    await auth.setCustomUserClaims(u.uid, { tenantId: TENANT.id, role: u.role });
  }
  return tenant.tenantId;
}

async function seedDb(firebaseTenantId: string) {
  const client = new pg.Client({ connectionString: DEV.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO control.tenants (id, name, firebase_tenant_id, email_domains)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             firebase_tenant_id = EXCLUDED.firebase_tenant_id,
             email_domains = EXCLUDED.email_domains`,
      [TENANT.id, TENANT.name, firebaseTenantId, TENANT.emailDomains],
    );
    for (const u of USERS) {
      await client.query(
        `INSERT INTO control.users (id, tenant_id, firebase_uid, email, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET firebase_uid = EXCLUDED.firebase_uid,
               email = EXCLUDED.email,
               role = EXCLUDED.role`,
        [u.id, TENANT.id, u.uid, u.email, u.role],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

async function seedStorage() {
  const res = await fetch(
    `${DEV.storageEmulatorHost}/storage/v1/b?project=${encodeURIComponent(DEV.firebaseProjectId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: DEV.contentBucket }),
    },
  );
  if (!res.ok && res.status !== 409) {
    throw new Error(`storage stub: creating bucket failed with HTTP ${res.status}`);
  }
}

try {
  const firebaseTenantId = await seedAuth();
  await seedDb(firebaseTenantId);
  await seedStorage();
  console.log(
    [
      'seed: done',
      `  tenant   ${TENANT.name}  id=${TENANT.id}  identity-platform-tenant=${firebaseTenantId}`,
      ...USERS.map((u) => `  ${u.role.padEnd(8)} ${u.email}  (password: ${DEV_PASSWORD})`),
      `  bucket   ${DEV.contentBucket}`,
    ].join('\n'),
  );
} catch (err) {
  console.error('seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
