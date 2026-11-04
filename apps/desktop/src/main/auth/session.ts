/**
 * Desktop sign-in session. Sign-in happens in the system browser (Google blocks OAuth inside
 * embedded windows; RFC 8252); tokens come back over a one-time loopback address. Tokens live
 * only in the main process: the refresh token is persisted encrypted with the OS keychain
 * (safeStorage), the short-lived ID token only in memory. The renderer never sees either.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { app, safeStorage, shell } from 'electron';
import { z } from 'zod';
import { corsHeaders, needsRefresh, validateCallback } from './callback';

const LoginConfig = z.object({
  apiKey: z.string(),
  emulatorUrl: z.string().nullable(),
});

const Me = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  userId: z.string(),
  role: z.enum(['employee', 'admin']),
  dataApiUrl: z.string(),
});
export type Me = z.infer<typeof Me>;

const Persisted = z.object({ refreshToken: z.string(), email: z.string().nullable() });

export type SessionStatus =
  | { signedIn: false }
  | { signedIn: true; email: string | null; tenantName: string; role: 'employee' | 'admin' };

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CALLBACK_BYTES = 32 * 1024;

export class AuthSession {
  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private email: string | null = null;
  private me: Me | null = null;
  private pending: Server | null = null;
  private readonly file = join(app.getPath('userData'), 'session.bin');

  constructor(private readonly controlApiUrl: string) {}

  status(): SessionStatus {
    return this.me
      ? { signedIn: true, email: this.email, tenantName: this.me.tenantName, role: this.me.role }
      : { signedIn: false };
  }

  /** Data-plane endpoint for the signed-in tenant (from the control plane, never hard-coded). */
  dataApiUrl(): string | null {
    return this.me?.dataApiUrl ?? null;
  }

  /** Restore a saved session at startup, if any. */
  async restore(): Promise<SessionStatus> {
    if (!safeStorage.isEncryptionAvailable()) return this.status();
    try {
      const raw = safeStorage.decryptString(await readFile(this.file));
      const saved = Persisted.parse(JSON.parse(raw));
      this.refreshToken = saved.refreshToken;
      this.email = saved.email;
      await this.refresh();
      await this.loadMe();
    } catch {
      await this.signOut(); // unreadable, revoked or expired: start clean
    }
    return this.status();
  }

  /** @param onReceived called as soon as the browser hands the tokens back (before loading the profile). */
  async signIn(onReceived?: () => void): Promise<SessionStatus> {
    this.pending?.close();
    const state = randomBytes(32).toString('base64url');
    const allowedOrigin = new URL(this.controlApiUrl).origin;

    const payload = await new Promise<ReturnType<typeof validateCallback>>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('sign_in_timeout'));
      }, SIGN_IN_TIMEOUT_MS);

      const server = createServer((req, res) => {
        const cors = corsHeaders(req.headers.origin, allowedOrigin);
        if (!cors || req.url !== '/callback') {
          res.writeHead(403).end();
          return;
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors).end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, cors).end();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_CALLBACK_BYTES) req.destroy();
          else chunks.push(c);
        });
        req.on('end', () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* invalid JSON -> rejected below */
          }
          const valid = validateCallback(body, state);
          if (!valid) {
            res.writeHead(400, cors).end();
            return;
          }
          res.writeHead(204, cors).end();
          clearTimeout(timer);
          server.close();
          onReceived?.();
          resolve(valid);
        });
      });
      this.pending = server;
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        const url = `${this.controlApiUrl}/login?port=${port}&state=${state}`;
        void shell.openExternal(url);
      });
    }).finally(() => {
      this.pending = null;
    });

    if (!payload) throw new Error('sign_in_failed');
    this.idToken = payload.idToken;
    this.refreshToken = payload.refreshToken;
    this.email = payload.email ?? null;
    await this.persist();
    await this.loadMe();
    return this.status();
  }

  async signOut(): Promise<void> {
    this.idToken = this.refreshToken = this.email = null;
    this.me = null;
    await rm(this.file, { force: true });
  }

  /** A valid ID token, refreshed if it's about to expire. */
  async token(): Promise<string> {
    if (needsRefresh(this.idToken)) await this.refresh();
    if (!this.idToken) throw new Error('signed_out');
    return this.idToken;
  }

  /** Authenticated fetch against control-api or the tenant's data-api. Retries once on 401. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async () =>
      fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.token()}` },
      });
    let res = await send();
    if (res.status === 401 && this.refreshToken) {
      await this.refresh();
      res = await send();
    }
    return res;
  }

  private async loadMe(): Promise<void> {
    const res = await this.fetch(`${this.controlApiUrl}/me`);
    if (!res.ok) throw new Error(`me_${res.status}`);
    this.me = Me.parse(await res.json());
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new Error('signed_out');
    const config = LoginConfig.parse(
      await (await fetch(`${this.controlApiUrl}/login/config`)).json(),
    );
    const base = config.emulatorUrl
      ? `${config.emulatorUrl}/securetoken.googleapis.com`
      : 'https://securetoken.googleapis.com';
    const res = await fetch(`${base}/v1/token?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    if (!res.ok) throw new Error(`refresh_${res.status}`);
    const body = z
      .object({ id_token: z.string(), refresh_token: z.string() })
      .parse(await res.json());
    this.idToken = body.id_token;
    if (body.refresh_token !== this.refreshToken) {
      this.refreshToken = body.refresh_token;
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    // Without OS-level encryption we keep the session in memory only (sign in again next time).
    if (!this.refreshToken || !safeStorage.isEncryptionAvailable()) return;
    const data = JSON.stringify({ refreshToken: this.refreshToken, email: this.email });
    await writeFile(this.file, safeStorage.encryptString(data), { mode: 0o600 });
  }
}
