import {
  createDb,
  FirebaseTokenVerifier,
  GoogleIdTokenInternalAuth,
  listen,
  loadConfig,
  StaticTokenInternalAuth,
} from '@qhint/server-kit';
import { z } from 'zod';
import { buildApp } from './app';
import { PgControlStore } from './control-store';
import type { ControlDB } from './db/types';
import { BigQueryEventSink, PgEventSink } from './events';
import { FirebaseIdentityAdmin } from './identity';

const Config = z
  .object({
    NODE_ENV: z.string().default('development'),
    CONTROL_DATABASE_URL: z
      .string()
      .default('postgres://qhint_control_app:qhint_control_dev@127.0.0.1:5432/qhint'),
    FIREBASE_PROJECT_ID: z.string().default('demo-qhint'),
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
    FIREBASE_API_KEY: z.string().default('demo-api-key'),
    FIREBASE_AUTH_DOMAIN: z.string().optional(),
    // Local: shared token. Cloud Run: Google ID tokens from these service accounts.
    INTERNAL_TOKEN: z.string().min(32).optional(),
    INTERNAL_AUDIENCE: z.string().optional(),
    INTERNAL_ALLOWED_CALLERS: z.string().optional(),
    EVENTS_SINK: z.enum(['postgres', 'bigquery']).default('postgres'),
    BIGQUERY_DATASET: z.string().default('qhint_ops'),
    BIGQUERY_TABLE: z.string().default('operator_events'),
  })
  .refine((c) => c.INTERNAL_TOKEN || (c.INTERNAL_AUDIENCE && c.INTERNAL_ALLOWED_CALLERS), {
    path: ['INTERNAL_TOKEN'],
  });

const config = loadConfig(Config);
const production = config.NODE_ENV === 'production';
if (production && config.INTERNAL_TOKEN)
  throw new Error('INTERNAL_TOKEN is for local development only');

const store = new PgControlStore(createDb<ControlDB>(config.CONTROL_DATABASE_URL));
const verifier = new FirebaseTokenVerifier({
  projectId: config.FIREBASE_PROJECT_ID,
  emulatorHost: config.FIREBASE_AUTH_EMULATOR_HOST,
  production,
});

const app = buildApp({
  store,
  verifier,
  identity: new FirebaseIdentityAdmin(config.FIREBASE_PROJECT_ID),
  internal: config.INTERNAL_TOKEN
    ? new StaticTokenInternalAuth(config.INTERNAL_TOKEN)
    : new GoogleIdTokenInternalAuth({
        audience: config.INTERNAL_AUDIENCE!,
        allowedCallers: config.INTERNAL_ALLOWED_CALLERS!.split(','),
      }),
  events:
    config.EVENTS_SINK === 'bigquery'
      ? new BigQueryEventSink(config.BIGQUERY_DATASET, config.BIGQUERY_TABLE)
      : new PgEventSink(store),
  login: {
    apiKey: config.FIREBASE_API_KEY,
    authDomain: config.FIREBASE_AUTH_DOMAIN ?? `${config.FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: config.FIREBASE_PROJECT_ID,
    emulatorUrl: config.FIREBASE_AUTH_EMULATOR_HOST
      ? `http://${config.FIREBASE_AUTH_EMULATOR_HOST}`
      : null,
  },
  logger: true,
});

await listen(app, 8081);
