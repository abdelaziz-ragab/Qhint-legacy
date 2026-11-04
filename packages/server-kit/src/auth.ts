/**
 * Request authentication. The tenant, user and role come ONLY from a verified Firebase /
 * Identity Platform ID token (custom claims set by control-api), never from request bodies,
 * query strings or headers other than the bearer token.
 */
import { Id, Role } from '@qhint/schema';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';
import { forbidden, unauthenticated } from './errors';

/** What a verified token tells us, before checking that the user is provisioned. */
export interface VerifiedToken {
  firebaseUid: string;
  /** Identity Platform tenant the user signed in to (null = project-level user). */
  firebaseTenantId: string | null;
  email: string | null;
  emailVerified: boolean;
  claims: Record<string, unknown>;
}

export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedToken>;
}

/** Custom claims control-api sets once a user is provisioned. */
export const TenantClaims = z.object({ tenantId: Id, userId: Id, role: Role });

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: Role;
  firebaseUid: string;
  firebaseTenantId: string;
}

/**
 * Turn a verified token into an AuthContext, or refuse. A user without our claims, or without an
 * Identity Platform tenant, is not provisioned and gets nothing.
 */
export function toAuthContext(t: VerifiedToken): AuthContext {
  const claims = TenantClaims.safeParse(t.claims);
  if (!claims.success || !t.firebaseTenantId) throw forbidden('not_provisioned');
  return { ...claims.data, firebaseUid: t.firebaseUid, firebaseTenantId: t.firebaseTenantId };
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header);
  return match?.[1] ?? null;
}

let verifierCount = 0;

/** Reads `firebase.tenant` from a JWT payload WITHOUT verifying it (used only to route). */
export function unverifiedTenant(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      firebase?: { tenant?: unknown };
    };
    const tenant = parsed.firebase?.tenant;
    return typeof tenant === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(tenant) ? tenant : null;
  } catch {
    return null;
  }
}

export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly app: App;

  constructor(opts: { projectId: string; emulatorHost?: string; production: boolean }) {
    if (opts.emulatorHost) {
      // The emulator accepts unsigned tokens; it must never be reachable from production.
      if (opts.production) throw new Error('auth emulator must not be used in production');
      process.env.FIREBASE_AUTH_EMULATOR_HOST = opts.emulatorHost;
    } else if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new Error('FIREBASE_AUTH_EMULATOR_HOST is set but the emulator was not configured');
    }
    this.app = initializeApp(
      { projectId: opts.projectId },
      `verifier-${opts.projectId}-${++verifierCount}`,
    );
  }

  async verify(idToken: string): Promise<VerifiedToken> {
    try {
      // Pick the verifier by the token's (unverified) tenant, then verify for real with that
      // tenant's Auth instance, which also checks the token was issued for that tenant.
      const tenant = unverifiedTenant(idToken);
      const auth = getAuth(this.app);
      const decoded = tenant
        ? await auth.tenantManager().authForTenant(tenant).verifyIdToken(idToken)
        : await auth.verifyIdToken(idToken);
      const { uid, email, email_verified, firebase, ...rest } = decoded;
      return {
        firebaseUid: uid,
        firebaseTenantId: firebase.tenant ?? null,
        email: email ?? null,
        emailVerified: email_verified ?? false,
        claims: rest,
      };
    } catch {
      throw unauthenticated();
    }
  }
}

export interface RequireAuthOptions {
  verifier: TokenVerifier;
  /**
   * Returns the Identity Platform tenant id registered for our tenant. The token's tenant must
   * match it, so a user from one Identity Platform tenant can't carry claims for another.
   */
  expectedFirebaseTenant: (tenantId: string) => Promise<string | null>;
  roles?: Role[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Fastify hook that authenticates the request and sets `req.auth`. Use it as `onRequest` so
 * anonymous requests are rejected before their body is even parsed or validated.
 */
export function requireAuth(opts: RequireAuthOptions) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(req);
    if (!token) throw unauthenticated();
    const ctx = toAuthContext(await opts.verifier.verify(token));
    const expected = await opts.expectedFirebaseTenant(ctx.tenantId);
    if (!expected || expected !== ctx.firebaseTenantId) throw forbidden('tenant_mismatch');
    if (opts.roles && !opts.roles.includes(ctx.role)) throw forbidden();
    req.auth = ctx;
  };
}

/** The authenticated context; throws if a route forgot `requireAuth`. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
