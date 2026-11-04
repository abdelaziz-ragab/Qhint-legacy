import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Id, OperatorEvent } from '@qhint/schema';
import {
  authOf,
  bearerToken,
  createServer,
  forbidden,
  HttpError,
  type InternalVerifier,
  notFound,
  requireAuth,
  TenantClaims,
  type TokenVerifier,
  unauthenticated,
} from '@qhint/server-kit';
import { z } from 'zod';
import { type ControlStore, SignInMethods } from './control-store';
import type { EventSink } from './events';
import type { IdentityAdmin } from './identity';

export const SERVICE_NAME = 'control-api';

/** Public Firebase web config for the sign-in page (none of it is secret). */
export interface LoginConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  /** Set only in local development. */
  emulatorUrl: string | null;
}

export interface ControlDeps {
  store: ControlStore;
  identity: IdentityAdmin;
  verifier: TokenVerifier;
  internal: InternalVerifier;
  events: EventSink;
  login: LoginConfig;
  logger?: boolean;
}

const LOGIN_DIR = join(import.meta.dirname, '..', 'login');
const loginFile = (name: string) => readFileSync(join(LOGIN_DIR, name), 'utf8');

/**
 * Control plane: tenants, users, sign-in routing, data-plane lookup, operator analytics.
 * Never touches content tables (its database role can't).
 */
export function buildApp(deps: ControlDeps) {
  const app = createServer({ name: SERVICE_NAME, logger: deps.logger });
  const { store } = deps;

  const auth = requireAuth({
    verifier: deps.verifier,
    expectedFirebaseTenant: async (tenantId) =>
      (await store.tenant(tenantId))?.firebaseTenantId ?? null,
  });
  const internalOnly = (req: Parameters<InternalVerifier['verify']>[0]) =>
    deps.internal.verify(req);

  // ---------------------------------------------------------------- sign-in

  /** Which Identity Platform tenant should this email sign in to? */
  app.post(
    '/auth/discover',
    {
      schema: {
        body: z.object({ email: z.email().max(320) }),
        response: {
          200: z.object({
            firebaseTenantId: z.string(),
            tenantName: z.string(),
            /** Which buttons the sign-in page offers for this company. */
            methods: SignInMethods,
          }),
        },
      },
    },
    async (req) => {
      const tenant = await store.tenantForEmail(req.body.email);
      if (!tenant?.firebaseTenantId) throw new HttpError(404, 'unknown_account');
      return {
        firebaseTenantId: tenant.firebaseTenantId,
        tenantName: tenant.name,
        methods: tenant.signInMethods,
      };
    },
  );

  /**
   * Called right after sign-in. Links an invited user to their Identity Platform account and sets
   * the claims (tenantId, userId, role) that every other request relies on. The client must then
   * refresh its ID token to pick the claims up.
   */
  app.post(
    '/auth/session',
    {
      schema: {
        response: {
          200: z.object({
            status: z.enum(['ready', 'refresh']),
            tenantName: z.string(),
            role: z.enum(['employee', 'admin']),
          }),
        },
      },
    },
    async (req) => {
      const token = bearerToken(req);
      if (!token) throw unauthenticated();
      const t = await deps.verifier.verify(token);
      if (!t.firebaseTenantId) throw forbidden('not_provisioned');

      const tenant = await store.tenantByFirebaseTenant(t.firebaseTenantId);
      if (!tenant) throw forbidden('not_provisioned');
      if (!t.email || !t.emailVerified) throw forbidden('email_unverified');

      const user = await store.userByEmail(tenant.id, t.email);
      if (!user) throw forbidden('not_invited');
      if (user.firebaseUid && user.firebaseUid !== t.firebaseUid)
        throw forbidden('account_conflict');

      const claims = { tenantId: tenant.id, userId: user.id, role: user.role };
      const current = TenantClaims.safeParse(t.claims);
      const upToDate =
        current.success &&
        current.data.tenantId === claims.tenantId &&
        current.data.userId === claims.userId &&
        current.data.role === claims.role;

      if (!user.firebaseUid) await store.linkFirebaseUid(user.id, t.firebaseUid);
      if (!upToDate) await deps.identity.setClaims(t.firebaseTenantId, t.firebaseUid, claims);
      return {
        status: upToDate ? ('ready' as const) : ('refresh' as const),
        tenantName: tenant.name,
        role: user.role,
      };
    },
  );

  app.get(
    '/me',
    {
      onRequest: auth,
      schema: {
        response: {
          200: z.object({
            tenantId: z.string(),
            tenantName: z.string(),
            userId: z.string(),
            role: z.enum(['employee', 'admin']),
            /** Where this tenant's content lives (the desktop app talks to it directly). */
            dataApiUrl: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const a = authOf(req);
      const [tenant, plane] = await Promise.all([
        store.tenant(a.tenantId),
        store.dataPlane(a.tenantId),
      ]);
      if (!tenant || !plane) throw notFound();
      return {
        tenantId: a.tenantId,
        tenantName: tenant.name,
        userId: a.userId,
        role: a.role,
        dataApiUrl: plane.endpoint,
      };
    },
  );

  // ---------------------------------------------------------------- sign-in page (system browser)

  const securityHeaders = (emulator: string | null) => ({
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self' https://www.gstatic.com https://apis.google.com",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' http://127.0.0.1:* https://*.googleapis.com${emulator ? ` ${emulator}` : ''}`,
      `frame-src https://*.firebaseapp.com https://accounts.google.com${emulator ? ` ${emulator}` : ''}`,
      "img-src 'self' data: https://*.googleusercontent.com",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });

  app.get('/login', async (_req, reply) =>
    reply
      .headers(securityHeaders(deps.login.emulatorUrl))
      .type('text/html')
      .send(loginFile('index.html')),
  );
  app.get('/login/app.js', async (_req, reply) =>
    reply
      .headers({ 'cache-control': 'no-store' })
      .type('text/javascript')
      .send(loginFile('app.js')),
  );
  app.get('/login/config', async () => deps.login);

  // ---------------------------------------------------------------- internal (service-to-service)

  app.get(
    '/internal/data-planes/:tenantId',
    {
      onRequest: internalOnly,
      schema: {
        params: z.object({ tenantId: Id }),
        response: {
          200: z.object({
            tenantId: z.string(),
            firebaseTenantId: z.string(),
            endpoint: z.string(),
            bucket: z.string(),
            keyRef: z.string(),
            region: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const loc = await store.dataPlane(req.params.tenantId);
      if (!loc) throw notFound();
      return loc;
    },
  );

  app.post(
    '/internal/events',
    {
      onRequest: internalOnly,
      schema: { body: z.object({ events: z.array(OperatorEvent).max(500) }) },
    },
    async (req, reply) => {
      await deps.events.write(req.body.events);
      return reply.status(204).send();
    },
  );

  return app;
}
