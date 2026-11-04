import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerErrorHandler } from './errors';
import { loggerOptions } from './logger';

export function createServer(opts: { name: string; logger?: boolean; bodyLimit?: number }) {
  const app = Fastify({
    logger: opts.logger ? loggerOptions : false,
    bodyLimit: opts.bodyLimit ?? 1024 * 1024,
    // Never trust X-Forwarded-* for anything security-related; Cloud Run sets them itself.
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.get(
    '/healthz',
    {
      schema: {
        response: { 200: z.object({ status: z.literal('ok'), service: z.string() }) },
      },
    },
    async () => ({ status: 'ok' as const, service: opts.name }),
  );
  return app;
}

/** Start listening (loopback locally, all interfaces on Cloud Run) with graceful shutdown. */
export async function listen(app: FastifyInstance, defaultPort: number): Promise<void> {
  const port = Number(process.env.PORT ?? defaultPort);
  const host = process.env.HOST ?? (process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.listen({ port, host });
}
