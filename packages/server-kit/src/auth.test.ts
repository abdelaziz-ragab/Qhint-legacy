import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { authOf, requireAuth, type TokenVerifier, type VerifiedToken } from './auth';
import { unauthenticated } from './errors';
import { createServer } from './server';

const ACME = '00000000-0000-4000-8000-000000000001';
const GLOBEX = '00000000-0000-4000-8000-000000000002';
const ALICE = '00000000-0000-4000-8000-000000000101';

const base: VerifiedToken = {
  firebaseUid: 'uid-alice',
  firebaseTenantId: 'idp-acme',
  email: 'alice@acme.test',
  emailVerified: true,
  claims: { tenantId: ACME, userId: ALICE, role: 'employee' },
};

/** Tokens are just keys into this table. */
const tokens: Record<string, VerifiedToken> = {
  good: base,
  admin: { ...base, claims: { ...base.claims, role: 'admin' } },
  noClaims: { ...base, claims: {} },
  badRole: { ...base, claims: { ...base.claims, role: 'owner' } },
  noIdpTenant: { ...base, firebaseTenantId: null },
  // Claims say Globex, but the user signed in to Acme's Identity Platform tenant.
  crossTenant: { ...base, claims: { ...base.claims, tenantId: GLOBEX } },
};

const verifier: TokenVerifier = {
  async verify(t) {
    const v = tokens[t];
    if (!v) throw unauthenticated();
    return v;
  },
};

const idpTenantOf: Record<string, string> = { [ACME]: 'idp-acme', [GLOBEX]: 'idp-globex' };

function app() {
  const a = createServer({ name: 'test' });
  const expectedFirebaseTenant = async (t: string) => idpTenantOf[t] ?? null;
  a.post(
    '/whoami',
    {
      preHandler: requireAuth({ verifier, expectedFirebaseTenant }),
      schema: { body: z.object({ tenantId: z.string() }).partial() },
    },
    async (req) => authOf(req),
  );
  a.get(
    '/admin',
    { preHandler: requireAuth({ verifier, expectedFirebaseTenant, roles: ['admin'] }) },
    async () => ({ ok: true }),
  );
  return a;
}

const call = (token: string | undefined, url = '/whoami', body: object = {}) =>
  app().inject({
    method: url === '/admin' ? 'GET' : 'POST',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(url === '/admin' ? {} : { payload: body }),
  });

describe('requireAuth', () => {
  it('accepts a provisioned user and exposes tenant/user/role from the token', async () => {
    const res = await call('good');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenantId: ACME, userId: ALICE, role: 'employee' });
  });

  it('ignores a tenantId supplied in the request body', async () => {
    const res = await call('good', '/whoami', { tenantId: GLOBEX });
    expect(res.json().tenantId).toBe(ACME);
  });

  it('rejects a missing or malformed bearer token with 401', async () => {
    expect((await call(undefined)).statusCode).toBe(401);
    const res = await app().inject({
      method: 'POST',
      url: '/whoami',
      headers: { authorization: 'Basic abc' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown/invalid token with 401', async () => {
    expect((await call('forged')).statusCode).toBe(401);
  });

  it('rejects users without our claims (not provisioned)', async () => {
    const res = await call('noClaims');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'not_provisioned' } });
    expect((await call('badRole')).statusCode).toBe(403);
    expect((await call('noIdpTenant')).statusCode).toBe(403);
  });

  it('rejects claims for a tenant other than the Identity Platform tenant signed in to', async () => {
    const res = await call('crossTenant');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'tenant_mismatch' } });
  });

  it('enforces roles', async () => {
    expect((await call('good', '/admin')).statusCode).toBe(403);
    expect((await call('admin', '/admin')).statusCode).toBe(200);
  });
});

describe('unverifiedTenant', () => {
  const jwt = (payload: object) =>
    `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

  it('reads the tenant for routing only', async () => {
    const { unverifiedTenant } = await import('./auth');
    expect(unverifiedTenant(jwt({ firebase: { tenant: 'acme-x1Y2' } }))).toBe('acme-x1Y2');
    expect(unverifiedTenant(jwt({ firebase: {} }))).toBeNull();
    expect(unverifiedTenant(jwt({ firebase: { tenant: '../../etc' } }))).toBeNull();
    expect(unverifiedTenant('garbage')).toBeNull();
  });
});
