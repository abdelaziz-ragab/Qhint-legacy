import type { FastifyError } from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger';

describe('content-free logger', () => {
  it('drops error messages, including from the stack header', () => {
    const err = new Error('user asked: how do I get VPN access?') as FastifyError;
    err.code = 'FST_ERR_TEST';
    const out = loggerOptions.serializers.err(err);
    expect(JSON.stringify(out)).not.toContain('VPN');
    expect(out.message).toBe('[redacted]');
    expect(out.code).toBe('FST_ERR_TEST');
    expect(out.stack).toMatch(/^\s+at /);
  });

  it('logs the route pattern, never the raw url or query string', () => {
    const out = loggerOptions.serializers.req({
      id: 'req-1',
      method: 'GET',
      routeOptions: { url: '/search' },
      // a real request would also carry url: '/search?q=salary+bands'; it must not be logged
    });
    expect(out).toEqual({ id: 'req-1', method: 'GET', route: '/search' });
  });
});
