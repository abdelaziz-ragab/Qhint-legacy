import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loggerOptions } from './logger';

export const SERVICE_NAME = 'data-api';

/** Data plane: procedures, docs, search, runs, gaps, model gateway. All content access goes through the data-plane store. */
export function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ? loggerOptions : false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/healthz',
    {
      schema: {
        response: { 200: z.object({ status: z.literal('ok'), service: z.literal(SERVICE_NAME) }) },
      },
    },
    async () => ({ status: 'ok', service: SERVICE_NAME }) as const,
  );

  return app;
}
