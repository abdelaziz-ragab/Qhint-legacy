import { type TokenVerifier, unauthenticated, type VerifiedToken } from '@qhint/server-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { defaultGatewayConfig } from './gateway/config';
import { FakeModelProvider } from './gateway/fake-provider';
import { ModelGateway } from './gateway/gateway';
import type { DataPlaneResolver } from './plane';
import type { StorageProvider } from './storage';
import type { DataPlaneStore, TenantContext } from './store/store';

const ACME = '00000000-0000-4000-8000-000000000001';
const GLOBEX = '00000000-0000-4000-8000-000000000002';
const EMP = '00000000-0000-4000-8000-000000000101';
const ADMIN = '00000000-0000-4000-8000-000000000102';
const DOC = '00000000-0000-4000-8000-00000000d0c1';

const tok = (userId: string, role: 'employee' | 'admin', idp = 'idp-acme'): VerifiedToken => ({
  firebaseUid: `fb-${userId}`,
  firebaseTenantId: idp,
  email: null,
  emailVerified: true,
  claims: { tenantId: ACME, userId, role },
});
const tokens: Record<string, VerifiedToken> = {
  employee: tok(EMP, 'employee'),
  admin: tok(ADMIN, 'admin'),
  wrongIdp: tok(EMP, 'employee', 'idp-globex'),
};

function harness() {
  const seen: { method: string; ctx: TenantContext; arg?: unknown }[] = [];
  const record = (method: string) => async (ctx: TenantContext, arg?: unknown) => {
    seen.push({ method, ctx, arg });
    return true;
  };
  const store: DataPlaneStore = {
    procedures: {
      list: async (ctx, scope) => (seen.push({ method: 'list', ctx, arg: scope }), []),
      get: async () => null,
      create: async (ctx, input) => (
        seen.push({ method: 'create', ctx, arg: input }),
        { id: 'p' } as never
      ),
      submitForReview: record('submit') as never,
      publish: record('publish') as never,
    },
    documents: {
      create: async (ctx, input) => {
        seen.push({ method: 'doc', ctx, arg: input });
        return {
          id: DOC,
          storageKey: `t/${ctx.tenantId}/${input.kind}/${DOC}`,
          contentType: input.contentType,
        } as never;
      },
      get: async () => null,
      markUploaded: record('uploaded') as never,
    },
    gaps: { create: async () => ({}) as never, list: async () => [] },
  };
  const verifier: TokenVerifier = {
    async verify(t) {
      const v = tokens[t];
      if (!v) throw unauthenticated();
      return v;
    },
  };
  const planes: DataPlaneResolver = {
    async resolve(tenantId) {
      return tenantId === ACME
        ? {
            tenantId,
            firebaseTenantId: 'idp-acme',
            endpoint: 'x',
            bucket: 'acme-bucket',
            keyRef: 'v1',
            region: 'r',
          }
        : null;
    },
  };
  const uploads: { bucket: string; key: string }[] = [];
  const storage: StorageProvider = {
    async uploadUrl(bucket, key, contentType) {
      uploads.push({ bucket, key });
      return {
        url: 'https://signed',
        method: 'PUT',
        headers: { 'content-type': contentType },
        expiresAt: 'soon',
      };
    },
    async downloadUrl() {
      throw new Error('unused');
    },
  };
  const provider = new FakeModelProvider(() =>
    JSON.stringify({
      kind: 'found',
      screen: 'screen_1',
      bbox: [10, 10, 60, 30],
      confidence: 'high',
      label: 'Insert',
      reason: null,
      hint: null,
    }),
  );
  const gateway = new ModelGateway(provider, defaultGatewayConfig('k'.repeat(32)), () => {});
  return { app: buildApp({ store, verifier, planes, storage, gateway }), seen, uploads, provider };
}

const as = (t: string) => ({ authorization: `Bearer ${t}` });
const video = { kind: 'video', title: 'Loom', contentType: 'video/mp4', sizeBytes: 10_000_000 };

describe('data-api', () => {
  it.each([
    ['GET', '/procedures'],
    ['GET', `/procedures/${DOC}`],
    ['POST', '/procedures'],
    ['POST', `/procedures/${DOC}/submit`],
    ['POST', `/procedures/${DOC}/publish`],
    ['POST', '/uploads'],
    ['POST', `/uploads/${DOC}/complete`],
    ['GET', '/gaps'],
    ['POST', '/gaps'],
    ['POST', '/locate'],
  ])('%s %s requires sign-in', async (method, url) => {
    const { app } = harness();
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: method === 'POST' ? {} : undefined,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a token from a different Identity Platform tenant', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/procedures', headers: as('wrongIdp') });
    expect(res.json()).toEqual({ error: { code: 'tenant_mismatch' } });
  });

  it('passes the token’s tenant to the store and ignores any tenant in the body', async () => {
    const { app, seen } = harness();
    await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: as('employee'),
      payload: { ...video, tenantId: GLOBEX },
    });
    expect(seen[0]!.ctx).toEqual({
      tenantId: ACME,
      userId: EMP,
      role: 'employee',
      firebaseUid: `fb-${EMP}`,
      firebaseTenantId: 'idp-acme',
    });
  });

  it('issues a signed upload URL for the tenant’s bucket and prefix', async () => {
    const { app, uploads } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: as('employee'),
      payload: video,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ documentId: DOC, upload: { method: 'PUT' } });
    expect(uploads).toEqual([{ bucket: 'acme-bucket', key: `t/${ACME}/video/${DOC}` }]);
  });

  it.each([
    ['executable type', { ...video, contentType: 'application/x-msdownload' }],
    ['too large', { ...video, sizeBytes: 3 * 1024 ** 3 }],
    ['doc type for a video', { ...video, contentType: 'application/pdf' }],
    ['empty', { ...video, sizeBytes: 0 }],
  ])('rejects uploads: %s', async (_name, payload) => {
    const { app, uploads } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: as('employee'),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(uploads).toEqual([]);
  });

  it('only admins can see the review queue or publish', async () => {
    const { app } = harness();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/procedures?scope=review',
          headers: as('employee'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/procedures?scope=review', headers: as('admin') }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/procedures/${DOC}/publish`,
          headers: as('employee'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/procedures/${DOC}/publish`,
          headers: as('admin'),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('validates procedures with the shared schema', async () => {
    const { app, seen } = harness();
    const bad = await app.inject({
      method: 'POST',
      url: '/procedures',
      headers: as('employee'),
      payload: {
        title: 'x',
        source: 'doc',
        steps: [
          { id: 's1', instruction: 'Click', app: { name: 'A', kind: 'web' }, action: 'click' },
        ],
      },
    });
    expect(bad.statusCode).toBe(400); // click without a target
    expect(seen).toEqual([]);
  });

  it('returns 404 for procedures that do not exist or are not visible', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: `/procedures/${DOC}`,
      headers: as('employee'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('/locate', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
  const body = (over: Record<string, unknown> = {}) => ({
    screens: [{ label: 'screen_1', width: 1280, height: 720, jpeg }],
    step: {
      id: 's5',
      instruction: 'Click Insert',
      app: { name: 'LibreOffice Writer', kind: 'native' },
      action: 'click',
      target: { description: 'Insert button' },
    },
    ...over,
  });

  it('returns the gateway result for a signed-in user', async () => {
    const { app, provider } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/locate',
      headers: as('employee'),
      payload: body(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      result: { kind: 'found', screen: 'screen_1', bbox: [10, 10, 60, 30] },
      escalated: false,
    });
    // The image actually reached the model as a JPEG part.
    const parts = provider.calls[0]!.request.content;
    expect(parts.some((p) => p.type === 'image')).toBe(true);
  });

  it.each([
    [
      'a non-JPEG image',
      body({
        screens: [
          {
            label: 'screen_1',
            width: 1280,
            height: 720,
            jpeg: Buffer.from('<svg/>').toString('base64'),
          },
        ],
      }),
    ],
    [
      'too many screens',
      body({
        screens: Array.from({ length: 5 }, (_, i) => ({
          label: `screen_${i + 1}`,
          width: 100,
          height: 100,
          jpeg,
        })),
      }),
    ],
    [
      'an absurd size',
      body({ screens: [{ label: 'screen_1', width: 100000, height: 720, jpeg }] }),
    ],
    ['a bad label', body({ screens: [{ label: '../x', width: 1280, height: 720, jpeg }] })],
  ])('rejects %s without calling the model', async (_name, payload) => {
    const { app, provider } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/locate',
      headers: as('employee'),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('/verify', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
  const screens = [{ label: 'screen_1', width: 1280, height: 720, jpeg }];
  const body = {
    step: {
      id: 's1',
      instruction: 'Open the Table menu.',
      app: { name: 'LibreOffice Writer', kind: 'native' },
      action: 'click',
      target: { description: 'Table menu' },
      expectedAfter: 'The Table menu is open.',
    },
    before: screens,
    after: screens,
  };

  it('requires sign-in', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'POST', url: '/verify', payload: body })).statusCode).toBe(
      401,
    );
  });

  it('answers not_done when the model output is unusable (never assumes success)', async () => {
    const { app } = harness(); // the harness model answers with a locate result, not a verify result
    const res = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: as('employee'),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ status: 'not_done', explanation: '' });
  });
});
