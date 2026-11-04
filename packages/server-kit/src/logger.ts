import type { FastifyError, FastifyServerOptions } from 'fastify';

/** Keep only stack frames; the first line of a stack repeats the message, which may hold content. */
function framesOnly(stack: string | undefined): string {
  return (stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
}

/**
 * Content-free request logging: method, matched route pattern (never the raw URL or query
 * string), status and timing. Errors log only their type, code and stack frames; never
 * messages, which can echo user input.
 */
export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: {
    req(req: { method: string; id: string; routeOptions?: { url?: string } }) {
      return { id: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched' };
    },
    res(res: { statusCode: number }) {
      return { statusCode: res.statusCode };
    },
    err(err: FastifyError) {
      return {
        type: err.name,
        message: '[redacted]',
        stack: framesOnly(err.stack),
        code: err.code,
        statusCode: err.statusCode,
      };
    },
  },
} satisfies FastifyServerOptions['logger'];
