/**
 * Loopback sign-in callback (RFC 8252): the browser sign-in page POSTs tokens to
 * http://127.0.0.1:<port>/callback. Pure helpers here; the server lives in loopback.ts.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const CallbackPayload = z.object({
  state: z.string().min(32).max(128),
  idToken: z.string().min(20).max(8192),
  refreshToken: z.string().min(20).max(4096),
  firebaseTenantId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  email: z.email().nullable().optional(),
});
export type CallbackPayload = z.infer<typeof CallbackPayload>;

/** Accept the payload only if it is well-formed and carries the exact state we generated. */
export function validateCallback(body: unknown, expectedState: string): CallbackPayload | null {
  const parsed = CallbackPayload.safeParse(body);
  if (!parsed.success) return null;
  const a = Buffer.from(parsed.data.state);
  const b = Buffer.from(expectedState);
  return a.length === b.length && timingSafeEqual(a, b) ? parsed.data : null;
}

/**
 * CORS + Private Network Access headers for the sign-in page's origin only. Browsers send a
 * preflight before a public https page may POST to 127.0.0.1.
 */
export function corsHeaders(
  requestOrigin: string | undefined,
  allowedOrigin: string,
): Record<string, string> | null {
  if (requestOrigin !== allowedOrigin) return null;
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '60',
    vary: 'origin',
  };
}

/** Seconds until a JWT expires (reads `exp` without verifying; used only to schedule refresh). */
export function secondsUntilExpiry(jwt: string, nowMs = Date.now()): number {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp - Math.floor(nowMs / 1000) : 0;
  } catch {
    return 0;
  }
}

/** Refresh a little early so requests never go out with a token about to expire. */
export const REFRESH_MARGIN_SECONDS = 5 * 60;
export const needsRefresh = (jwt: string | null, nowMs = Date.now()) =>
  !jwt || secondsUntilExpiry(jwt, nowMs) < REFRESH_MARGIN_SECONDS;
