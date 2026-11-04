/**
 * Local dev seed: two tenants (Acme, Globex), each an Identity Platform tenant in the Firebase
 * Auth emulator with one admin and one employee, their control-plane records and data-plane
 * location, plus the content bucket in the storage stub. Idempotent; safe to run on every
 * `pnpm dev`. Refuses non-local targets.
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

interface SeedUser {
  id: string;
  uid: string;
  email: string;
  role: 'admin' | 'employee';
}
interface SeedTenant {
  id: string;
  name: string;
  firebaseDisplayName: string;
  emailDomains: string[];
  users: SeedUser[];
  /** Invited but never signed in: try "Continue with Google" with this email in the emulator. */
  invited: { id: string; email: string };
}

/** What the sign-in page offers each dev tenant (`control.tenants.sign_in_methods`). */
const SIGN_IN_METHODS = { password: true, google: true, microsoft: false, sso: null };

export const TENANTS: SeedTenant[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Acme (dev)',
    firebaseDisplayName: 'acme-dev',
    emailDomains: ['acme.test'],
    users: [
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
    ],
    invited: { id: '00000000-0000-4000-8000-000000000103', email: 'google.user@acme.test' },
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Globex (dev)',
    firebaseDisplayName: 'globex-dev',
    emailDomains: ['globex.test'],
    users: [
      {
        id: '00000000-0000-4000-8000-000000000201',
        uid: 'dev-globex-admin',
        email: 'admin@globex.test',
        role: 'admin',
      },
      {
        id: '00000000-0000-4000-8000-000000000202',
        uid: 'dev-globex-employee',
        email: 'employee@globex.test',
        role: 'employee',
      },
    ],
    invited: { id: '00000000-0000-4000-8000-000000000203', email: 'google.user@globex.test' },
  },
];

/** Emulator-only password for the seeded accounts (email + password sign-in). */
export const DEV_PASSWORD = 'qhint-dev-only';
const DATA_API_URL = process.env.DATA_API_URL ?? 'http://127.0.0.1:8082';

async function seedAuth(): Promise<Map<string, string>> {
  const app = initializeApp({ projectId: DEV.firebaseProjectId }, 'seed');
  const tm = getAuth(app).tenantManager();
  const { tenants: existing } = await tm.listTenants();
  const idpTenants = new Map<string, string>();

  // Email + password on, email link off. Applied to existing tenants too, so tenants created by
  // older seeds get password sign-in as well.
  const emailSignInConfig = { enabled: true, passwordRequired: true };
  for (const t of TENANTS) {
    const found = existing.find((e) => e.displayName === t.firebaseDisplayName);
    const idp = found
      ? await tm.updateTenant(found.tenantId, { emailSignInConfig })
      : await tm.createTenant({ displayName: t.firebaseDisplayName, emailSignInConfig });
    idpTenants.set(t.id, idp.tenantId);

    const auth = tm.authForTenant(idp.tenantId);
    for (const u of t.users) {
      const props = { email: u.email, password: DEV_PASSWORD, emailVerified: true };
      try {
        await auth.updateUser(u.uid, props);
      } catch {
        await auth.createUser({ uid: u.uid, ...props });
      }
      await auth.setCustomUserClaims(u.uid, { tenantId: t.id, userId: u.id, role: u.role });
    }
  }
  return idpTenants;
}

async function seedDb(idpTenants: Map<string, string>) {
  const client = new pg.Client({ connectionString: DEV.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const t of TENANTS) {
      await client.query(
        `INSERT INTO control.tenants (id, name, firebase_tenant_id, email_domains, sign_in_methods)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               firebase_tenant_id = EXCLUDED.firebase_tenant_id,
               email_domains = EXCLUDED.email_domains,
               sign_in_methods = EXCLUDED.sign_in_methods`,
        [t.id, t.name, idpTenants.get(t.id), t.emailDomains, JSON.stringify(SIGN_IN_METHODS)],
      );
      await client.query(
        `INSERT INTO control.data_plane_locations (tenant_id, endpoint, bucket, key_ref)
         VALUES ($1, $2, $3, 'v1')
         ON CONFLICT (tenant_id) DO UPDATE
           SET endpoint = EXCLUDED.endpoint, bucket = EXCLUDED.bucket, updated_at = now()`,
        [t.id, DATA_API_URL, DEV.contentBucket],
      );
      for (const u of t.users) {
        await client.query(
          `INSERT INTO control.users (id, tenant_id, firebase_uid, email, role)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE
             SET firebase_uid = EXCLUDED.firebase_uid,
                 email = EXCLUDED.email,
                 role = EXCLUDED.role`,
          [u.id, t.id, u.uid, u.email, u.role],
        );
      }
      // Reset every run: the emulator forgets accounts on restart, so the link must be redone.
      await client.query(
        `INSERT INTO control.users (id, tenant_id, firebase_uid, email, role)
         VALUES ($1, $2, NULL, $3, 'employee')
         ON CONFLICT (id) DO UPDATE SET firebase_uid = NULL, email = EXCLUDED.email`,
        [t.invited.id, t.id, t.invited.email],
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
  const idpTenants = await seedAuth();
  await seedDb(idpTenants);
  await seedStorage();
  console.log(
    [
      'seed: done',
      ...TENANTS.flatMap((t) => [
        `  tenant   ${t.name}  id=${t.id}  identity-platform-tenant=${idpTenants.get(t.id)}`,
        ...t.users.map((u) => `    ${u.role.padEnd(8)} ${u.email}`),
        `    invited  ${t.invited.email}  (use with "Continue with Google")`,
      ]),
      `  password (emulator only): ${DEV_PASSWORD}`,
      `  bucket   ${DEV.contentBucket}`,
    ].join('\n'),
  );
} catch (err) {
  console.error('seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
