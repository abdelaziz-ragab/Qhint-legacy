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
import { HttpEventEmitter } from './events';
import { AnthropicProvider } from './gateway/anthropic-provider';
import { defaultGatewayConfig } from './gateway/config';
import { FakeModelProvider } from './gateway/fake-provider';
import { ModelGateway } from './gateway/gateway';
import { HttpDataPlaneResolver } from './plane';
import { EmulatorStorage, GcsStorage } from './storage';
import type { ContentDB } from './store/db-types';
import { PgDataPlaneStore } from './store/pg-store';

const Config = z
  .object({
    NODE_ENV: z.string().default('development'),
    DATA_DATABASE_URL: z
      .string()
      .default('postgres://qhint_data_app:qhint_data_dev@127.0.0.1:5432/qhint'),
    CONTROL_API_URL: z.string().default('http://127.0.0.1:8081'),
    FIREBASE_PROJECT_ID: z.string().default('demo-qhint'),
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
    STORAGE_EMULATOR_HOST: z.string().optional(),
    INTERNAL_TOKEN: z.string().min(32).optional(),
    ANTHROPIC_API_KEY: z.string().min(20).optional(),
    ANALYTICS_HASH_KEY: z.string().min(32),
  })
  .refine((c) => c.NODE_ENV !== 'production' || !c.INTERNAL_TOKEN, { path: ['INTERNAL_TOKEN'] });

const config = loadConfig(Config);
const production = config.NODE_ENV === 'production';
if (production && config.STORAGE_EMULATOR_HOST) throw new Error('storage emulator in production');

if (production && !config.ANTHROPIC_API_KEY)
  throw new Error('ANTHROPIC_API_KEY is required in production');

const caller = config.INTERNAL_TOKEN
  ? new StaticTokenInternalAuth(config.INTERNAL_TOKEN)
  : new GoogleIdTokenInternalAuth({ audience: config.CONTROL_API_URL, allowedCallers: [] });

const events = new HttpEventEmitter(config.CONTROL_API_URL, caller);
// Without a key (local development only) the AI answers "not sure" instead of failing.
const provider = config.ANTHROPIC_API_KEY
  ? new AnthropicProvider(config.ANTHROPIC_API_KEY)
  : new FakeModelProvider(() =>
      JSON.stringify({
        kind: 'none',
        screen: null,
        bbox: null,
        confidence: null,
        label: null,
        reason: 'low_confidence',
        hint: 'AI is not configured on this server',
      }),
    );
if (!config.ANTHROPIC_API_KEY)
  console.warn('ANTHROPIC_API_KEY not set: model calls answer "not sure"');
const gateway = new ModelGateway(
  provider,
  defaultGatewayConfig(config.ANALYTICS_HASH_KEY),
  events.emit,
);

const app = buildApp({
  store: new PgDataPlaneStore(createDb<ContentDB>(config.DATA_DATABASE_URL)),
  verifier: new FirebaseTokenVerifier({
    projectId: config.FIREBASE_PROJECT_ID,
    emulatorHost: config.FIREBASE_AUTH_EMULATOR_HOST,
    production,
  }),
  planes: new HttpDataPlaneResolver(config.CONTROL_API_URL, caller),
  storage: config.STORAGE_EMULATOR_HOST
    ? new EmulatorStorage(config.STORAGE_EMULATOR_HOST)
    : new GcsStorage(),
  gateway,
  logger: true,
});

await listen(app, 8082);
