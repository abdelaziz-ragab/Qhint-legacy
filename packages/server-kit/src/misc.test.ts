import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config';
import { hashId } from './hash';
import { StaticTokenInternalAuth } from './internal-auth';
import { createServer } from './server';

describe('loadConfig', () => {
  const schema = z.object({ DATABASE_URL: z.string().url(), SECRET: z.string().min(10) });

  it('parses valid env', () => {
    expect(loadConfig(schema, { DATABASE_URL: 'postgres://h/db', SECRET: 'x'.repeat(10) })).toEqual(
      { DATABASE_URL: 'postgres://h/db', SECRET: 'x'.repeat(10) },
    );
  });

  it('names bad variables without echoing their values', () => {
    const run = () => loadConfig(schema, { DATABASE_URL: 'not a url', SECRET: 'short-pw' });
    expect(run).toThrow(/DATABASE_URL, SECRET/);
    expect(run).not.toThrow(/short-pw|not a url/);
  });
});

describe('hashId', () => {
  const key = 'k'.repeat(32);

  it('is stable, hex and key-dependent', () => {
    const a = hashId(key, 'tenant-1');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hashId(key, 'tenant-1')).toBe(a);
    expect(hashId('j'.repeat(32), 'tenant-1')).not.toBe(a);
  });

  it('refuses short keys', () => {
    expect(() => hashId('short', 'x')).toThrow();
  });
});

describe('error responses', () => {
  it('do not echo request content on validation errors', async () => {
    const app = createServer({ name: 't' });
    app.post('/x', { schema: { body: z.object({ n: z.number() }) } }, async () => ({}));
    const res = await app.inject({ method: 'POST', url: '/x', payload: { n: 'salary data' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('salary');
    expect(res.json()).toEqual({ error: { code: 'invalid_request' } });
  });

  it('return a uniform 404', async () => {
    const res = await createServer({ name: 't' }).inject({ method: 'GET', url: '/nope?q=secret' });
    expect(res.json()).toEqual({ error: { code: 'not_found' } });
  });
});

describe('StaticTokenInternalAuth', () => {
  const auth = new StaticTokenInternalAuth('t'.repeat(40));

  async function status(header?: string) {
    const app = createServer({ name: 't' });
    app.get('/internal', { preHandler: (req) => auth.verify(req) }, async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/internal',
      headers: header ? { authorization: header } : {},
    });
    return res.statusCode;
  }

  it('accepts the shared token and rejects others', async () => {
    expect(await status(`Bearer ${'t'.repeat(40)}`)).toBe(200);
    expect(await status(`Bearer ${'u'.repeat(40)}`)).toBe(403);
    expect(await status()).toBe(401);
  });

  it('refuses weak tokens', () => {
    expect(() => new StaticTokenInternalAuth('short')).toThrow();
  });
});
