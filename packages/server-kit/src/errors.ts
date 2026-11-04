import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * An error safe to return to clients: a status and a stable machine-readable code. Messages are
 * never sent or logged, so they can't leak request content.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export const unauthenticated = () => new HttpError(401, 'unauthenticated');
export const forbidden = (code = 'forbidden') => new HttpError(403, code);
export const notFound = () => new HttpError(404, 'not_found');
export const badRequest = (code = 'invalid_request') => new HttpError(400, code);

/** Uniform error responses: `{ error: { code } }`. Validation details are not echoed back. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code } });
    }
    if ((err as FastifyError).validation) {
      return reply.status(400).send({ error: { code: 'invalid_request' } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'invalid_request' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found' } }));
}
