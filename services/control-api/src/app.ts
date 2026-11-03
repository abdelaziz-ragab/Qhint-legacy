import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loggerOptions } from './logger';

export const SERVICE_NAME = 'control-api';

/** Control plane: tenants, users, plans, data-plane lookup, app updates. Never touches content tables. */
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
