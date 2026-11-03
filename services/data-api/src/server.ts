import { buildApp } from './app';

const port = Number(process.env.PORT ?? 8082);
// Bind to all interfaces only on Cloud Run; keep local dev on loopback.
const host = process.env.HOST ?? (process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');

const app = buildApp({ logger: true });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port, host });
