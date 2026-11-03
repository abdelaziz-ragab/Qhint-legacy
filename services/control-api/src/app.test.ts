import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('control-api', () => {
  it('responds to /healthz', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'control-api' });
    await app.close();
  });

  it('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
