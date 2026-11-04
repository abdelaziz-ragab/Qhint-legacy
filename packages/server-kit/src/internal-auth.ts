/**
 * Service-to-service auth (data-api -> control-api internal endpoints). Production uses Google-
 * signed ID tokens tied to the caller's service account; local development uses a shared token.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { forbidden, unauthenticated } from './errors';
import { bearerToken } from './auth';

export interface InternalCaller {
  /** Headers to attach when calling another service. */
  headers(audience: string): Promise<Record<string, string>>;
}

export interface InternalVerifier {
  verify(req: FastifyRequest): Promise<void>;
}

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Local development only. */
export class StaticTokenInternalAuth implements InternalCaller, InternalVerifier {
  constructor(private readonly token: string) {
    if (token.length < 32) throw new Error('internal token must be at least 32 characters');
  }
  async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${this.token}` };
  }
  async verify(req: FastifyRequest): Promise<void> {
    const got = bearerToken(req);
    if (!got) throw unauthenticated();
    if (!sameSecret(got, this.token)) throw forbidden();
  }
}

/** Cloud Run: caller sends a Google ID token; callee checks audience and service account. */
export class GoogleIdTokenInternalAuth implements InternalCaller, InternalVerifier {
  private readonly auth = new GoogleAuth();
  private readonly verifier = new OAuth2Client();

  constructor(
    private readonly opts: {
      /** This service's URL (expected audience when verifying). */
      audience: string;
      /** Service accounts allowed to call this service. */
      allowedCallers: string[];
    },
  ) {}

  async headers(audience: string): Promise<Record<string, string>> {
    const client = await this.auth.getIdTokenClient(audience);
    return (await client.getRequestHeaders()) as unknown as Record<string, string>;
  }

  async verify(req: FastifyRequest): Promise<void> {
    const token = bearerToken(req);
    if (!token) throw unauthenticated();
    try {
      const ticket = await this.verifier.verifyIdToken({
        idToken: token,
        audience: this.opts.audience,
      });
      const email = ticket.getPayload()?.email;
      if (!email || !this.opts.allowedCallers.includes(email)) throw new Error('caller');
    } catch {
      throw forbidden();
    }
  }
}
