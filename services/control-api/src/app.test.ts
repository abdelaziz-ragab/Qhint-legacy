import type { OperatorEvent } from '@qhint/schema';
import {
  StaticTokenInternalAuth,
  type TokenVerifier,
  unauthenticated,
  type VerifiedToken,
} from '@qhint/server-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import {
  type ControlStore,
  type DataPlaneLocation,
  DEFAULT_SIGN_IN_METHODS,
  parseSignInMethods,
  type TenantRecord,
  type UserRecord,
} from './control-store';
import type { UserClaims } from './identity';

const ACME = '00000000-0000-4000-8000-000000000001';
const GLOBEX = '00000000-0000-4000-8000-000000000002';
const INITECH = '00000000-0000-4000-8000-000000000003';
const HOOLI = '00000000-0000-4000-8000-000000000004';
const INTERNAL = 'i'.repeat(40);
const ALICE_ID = '00000000-0000-4000-8000-000000000101';
const BOB_ID = '00000000-0000-4000-8000-000000000102';

function harness() {
  // Raw jsonb as stored, parsed the same way PgControlStore does.
  const stored: { id: string; name: string; firebaseTenantId: string; methods: unknown }[] = [
    { id: ACME, name: 'Acme', firebaseTenantId: 'idp-acme', methods: DEFAULT_SIGN_IN_METHODS },
    {
      id: GLOBEX,
      name: 'Globex',
      firebaseTenantId: 'idp-globex',
      methods: DEFAULT_SIGN_IN_METHODS,
    },
    {
      id: INITECH,
      name: 'Initech',
      firebaseTenantId: 'idp-initech',
      methods: {
        password: false,
        google: false,
        microsoft: false,
        sso: { type: 'saml', providerId: 'saml.initech', label: 'Initech Okta' },
      },
    },
    // Hand-edited row with a typo'd key and a bad provider id.
    {
      id: HOOLI,
      name: 'Hooli',
      firebaseTenantId: 'idp-hooli',
      methods: { pasword: false, google: true, microsoft: false, sso: { type: 'saml' } },
    },
  ];
  const tenants: TenantRecord[] = stored.map((t) => ({
    id: t.id,
    name: t.name,
    firebaseTenantId: t.firebaseTenantId,
    signInMethods: parseSignInMethods(t.methods),
  }));
  const users: UserRecord[] = [
    { id: ALICE_ID, tenantId: ACME, email: 'alice@acme.test', role: 'admin', firebaseUid: null },
    {
      id: BOB_ID,
      tenantId: ACME,
      email: 'Bob@acme.test',
      role: 'employee',
      firebaseUid: 'fb-bob',
    },
  ];
  const domains: Record<string, string> = {
    'acme.test': ACME,
    'globex.test': GLOBEX,
    'initech.test': INITECH,
    'hooli.test': HOOLI,
  };
  const events: OperatorEvent[] = [];
  const claimsSet: { idp: string; uid: string; claims: UserClaims }[] = [];

  const store: ControlStore = {
    async tenantForEmail(email) {
      const u = users.filter((x) => x.email.toLowerCase() === email.toLowerCase());
      if (u.length === 1) return tenants.find((t) => t.id === u[0]!.tenantId) ?? null;
      const id = domains[email.split('@')[1]!];
      return tenants.find((t) => t.id === id) ?? null;
    },
    async tenant(id) {
      return tenants.find((t) => t.id === id) ?? null;
    },
    async tenantByFirebaseTenant(idp) {
      return tenants.find((t) => t.firebaseTenantId === idp) ?? null;
    },
    async userByEmail(tenantId, email) {
      return (
        users.find(
          (u) => u.tenantId === tenantId && u.email.toLowerCase() === email.toLowerCase(),
        ) ?? null
      );
    },
    async linkFirebaseUid(userId, uid) {
      const u = users.find((x) => x.id === userId)!;
      u.firebaseUid ??= uid;
    },
    async dataPlane(tenantId): Promise<DataPlaneLocation | null> {
      const t = tenants.find((x) => x.id === tenantId);
      return t
        ? {
            tenantId,
            firebaseTenantId: t.firebaseTenantId!,
            endpoint: 'http://data',
            bucket: 'b',
            keyRef: 'k',
            region: 'r',
          }
        : null;
    },
    async insertEvents(e) {
      events.push(...e);
    },
  };

  const tokenTable: Record<string, VerifiedToken> = {
    aliceFresh: {
      firebaseUid: 'fb-alice',
      firebaseTenantId: 'idp-acme',
      email: 'alice@acme.test',
      emailVerified: true,
      claims: {},
    },
    aliceReady: {
      firebaseUid: 'fb-alice',
      firebaseTenantId: 'idp-acme',
      email: 'alice@acme.test',
      emailVerified: true,
      claims: { tenantId: ACME, userId: ALICE_ID, role: 'admin' },
    },
    stranger: {
      firebaseUid: 'fb-x',
      firebaseTenantId: 'idp-acme',
      email: 'mallory@acme.test',
      emailVerified: true,
      claims: {},
    },
    unverified: {
      firebaseUid: 'fb-alice',
      firebaseTenantId: 'idp-acme',
      email: 'alice@acme.test',
      emailVerified: false,
      claims: {},
    },
    bobImpostor: {
      firebaseUid: 'fb-other',
      firebaseTenantId: 'idp-acme',
      email: 'bob@acme.test',
      emailVerified: true,
      claims: {},
    },
    // Alice's email, but signed in to Globex's Identity Platform tenant.
    aliceWrongIdp: {
      firebaseUid: 'fb-a2',
      firebaseTenantId: 'idp-globex',
      email: 'alice@acme.test',
      emailVerified: true,
      claims: {},
    },
  };
  const verifier: TokenVerifier = {
    async verify(t) {
      const v = tokenTable[t];
      if (!v) throw unauthenticated();
      return v;
    },
  };

  const app = buildApp({
    store,
    verifier,
    identity: {
      async setClaims(idp, uid, claims) {
        claimsSet.push({ idp, uid, claims });
      },
    },
    internal: new StaticTokenInternalAuth(INTERNAL),
    events: {
      async write(e) {
        await store.insertEvents(e);
      },
    },
    login: { apiKey: 'k', authDomain: 'd', projectId: 'p', emulatorUrl: null },
  });
  return { app, users, events, claimsSet };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const discover = (app: ReturnType<typeof harness>['app'], email: string) =>
  app.inject({ method: 'POST', url: '/auth/discover', payload: { email } });

describe('/auth/discover', () => {
  it('routes invited emails and known domains to their tenant and its sign-in methods', async () => {
    const { app } = harness();
    const r1 = await discover(app, 'ALICE@acme.test');
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({
      firebaseTenantId: 'idp-acme',
      tenantName: 'Acme',
      methods: { password: true, google: true, microsoft: false, sso: null },
    });
    const r2 = await discover(app, 'new@globex.test');
    expect(r2.json()).toEqual({
      firebaseTenantId: 'idp-globex',
      tenantName: 'Globex',
      methods: { password: true, google: true, microsoft: false, sso: null },
    });
  });

  it('reports the tenant’s own methods (password disabled, SSO configured)', async () => {
    const { app } = harness();
    const res = await discover(app, 'peter@initech.test');
    expect(res.json()).toEqual({
      firebaseTenantId: 'idp-initech',
      tenantName: 'Initech',
      methods: {
        password: false,
        google: false,
        microsoft: false,
        sso: { type: 'saml', providerId: 'saml.initech', label: 'Initech Okta' },
      },
    });
  });

  it('falls back to the default methods when the stored value is invalid', async () => {
    const { app } = harness();
    const res = await discover(app, 'gavin@hooli.test');
    expect(res.statusCode).toBe(200);
    expect(res.json().methods).toEqual(DEFAULT_SIGN_IN_METHODS);
  });

  it('returns unknown_account for everything else', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/discover',
      payload: { email: 'x@gmail.com' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'unknown_account' } });
  });
});

describe('parseSignInMethods', () => {
  it.each([
    ['null', null],
    ['a string', 'password'],
    ['a missing key', { password: true, google: true, sso: null }],
    ['a non-boolean', { password: 'yes', google: true, microsoft: false, sso: null }],
    [
      'a bad provider id',
      {
        password: true,
        google: true,
        microsoft: false,
        sso: { type: 'oidc', providerId: 'okta', label: 'x' },
      },
    ],
    [
      'a too-long label',
      {
        password: true,
        google: true,
        microsoft: false,
        sso: { type: 'oidc', providerId: 'oidc.okta', label: 'x'.repeat(61) },
      },
    ],
  ])('defaults on %s', (_name, stored) => {
    expect(parseSignInMethods(stored)).toEqual(DEFAULT_SIGN_IN_METHODS);
  });

  it('keeps a valid stored value', () => {
    const v = {
      password: true,
      google: false,
      microsoft: true,
      sso: { type: 'oidc', providerId: 'oidc.entra-1', label: 'Contoso' },
    };
    expect(parseSignInMethods(v)).toEqual(v);
  });
});

describe('/auth/session', () => {
  it('links an invited user on first sign-in and sets claims from our records', async () => {
    const { app, users, claimsSet } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: bearer('aliceFresh'),
    });
    expect(res.json()).toEqual({ status: 'refresh', tenantName: 'Acme', role: 'admin' });
    expect(users[0]!.firebaseUid).toBe('fb-alice');
    expect(claimsSet).toEqual([
      {
        idp: 'idp-acme',
        uid: 'fb-alice',
        claims: { tenantId: ACME, userId: ALICE_ID, role: 'admin' },
      },
    ]);
  });

  it('is a no-op once claims are current', async () => {
    const { app, claimsSet } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: bearer('aliceReady'),
    });
    expect(res.json().status).toBe('ready');
    expect(claimsSet).toEqual([]);
  });

  it.each([
    ['stranger', 403, 'not_invited'],
    ['unverified', 403, 'email_unverified'],
    ['bobImpostor', 403, 'account_conflict'],
    ['aliceWrongIdp', 403, 'not_invited'],
    ['garbage', 401, 'unauthenticated'],
  ])('refuses %s', async (token, status, code) => {
    const { app, claimsSet } = harness();
    const res = await app.inject({ method: 'POST', url: '/auth/session', headers: bearer(token) });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code } });
    expect(claimsSet).toEqual([]);
  });
});

describe('/me', () => {
  it('requires provisioned claims', async () => {
    const { app } = harness();
    expect(
      (await app.inject({ method: 'GET', url: '/me', headers: bearer('aliceFresh') })).statusCode,
    ).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/me', headers: bearer('aliceReady') });
    expect(ok.json()).toEqual({
      tenantId: ACME,
      tenantName: 'Acme',
      userId: ALICE_ID,
      role: 'admin',
      dataApiUrl: 'http://data',
    });
  });
});

describe('internal endpoints', () => {
  it('reject callers without the internal credential (even signed-in users)', async () => {
    const { app } = harness();
    const url = `/internal/data-planes/${ACME}`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url, headers: bearer('aliceReady') })).statusCode,
    ).toBe(403);
    const ok = await app.inject({ method: 'GET', url, headers: bearer(INTERNAL) });
    expect(ok.json()).toMatchObject({ tenantId: ACME, firebaseTenantId: 'idp-acme' });
  });

  it('accept whitelisted operator events and reject content', async () => {
    const { app, events } = harness();
    const event = {
      type: 'model_call',
      ts: '2026-11-04T12:00:00.000Z',
      tenantHash: 'a'.repeat(64),
      callType: 'locate',
      latencyMs: 900,
    };
    const ok = await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: bearer(INTERNAL),
      payload: { events: [event] },
    });
    expect(ok.statusCode).toBe(204);
    expect(events).toHaveLength(1);

    const bad = await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: bearer(INTERNAL),
      payload: { events: [{ ...event, question: 'how do I see salaries?' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('salaries');
    expect(events).toHaveLength(1);
  });
});

describe('/login', () => {
  it('is served with a strict content security policy', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/login?port=5000&state=x' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toContain('Sign in to Qhint');
  });
});

describe('healthz', () => {
  it('responds', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok', service: 'control-api' });
  });
});
