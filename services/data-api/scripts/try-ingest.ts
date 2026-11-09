/**
 * Development tool: run one local video or document through the real ingest pipeline and print
 * the guide it produces. Uses the real model (ANTHROPIC_API_KEY from .env) with in-memory
 * storage and store, so nothing is saved to the database. Example:
 *   pnpm --filter @qhint/data-api try-ingest ../../test-data/videos/calc-import-data.webm [en-US]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { Procedure } from '@qhint/schema';
import { AnthropicProvider } from '../src/gateway/anthropic-provider';
import { defaultGatewayConfig } from '../src/gateway/config';
import { ModelGateway } from '../src/gateway/gateway';
import { runIngestJob } from '../src/ingest/pipeline';
import { GoogleSpeechTranscriber, NoTranscriber } from '../src/ingest/transcribe';
import type { StorageProvider } from '../src/storage';
import type { DataPlaneStore, NewProcedure } from '../src/store/store';

const file = resolve(process.argv[2] ?? '');
const language = process.argv[3] ?? 'en-US';
const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error('ANTHROPIC_API_KEY missing (put it in .env)');

const TYPES: Record<string, [string, 'video' | 'doc']> = {
  '.mp4': ['video/mp4', 'video'],
  '.webm': ['video/webm', 'video'],
  '.mov': ['video/quicktime', 'video'],
  '.ogv': ['video/ogg', 'video'],
  '.pdf': ['application/pdf', 'doc'],
  '.txt': ['text/plain', 'doc'],
  '.md': ['text/markdown', 'doc'],
};
const [contentType, kind] = TYPES[extname(file).toLowerCase()] ?? [];
if (!contentType || !kind) throw new Error(`unsupported file type: ${file}`);

const TENANT = '00000000-0000-4000-8000-000000000001';
const SOURCE = `t/${TENANT}/${kind}/local`;
const objects = new Map<string, Buffer>([[SOURCE, readFileSync(file)]]);
const storage: StorageProvider = {
  uploadUrl: async () => ({ url: '', method: 'PUT', headers: {}, expiresAt: '' }),
  downloadUrl: async () => ({ url: '', method: 'GET', headers: {}, expiresAt: '' }),
  read: async (_b, k) => objects.get(k)!,
  write: async (_b, k, d) => void objects.set(k, d),
  remove: async (_b, k) => void objects.delete(k),
  size: async (_b, k) => objects.get(k)?.length ?? null,
};

let created: NewProcedure | null = null;
let report: unknown = null;
let failure: string | null = null;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const store = {
  documents: {
    get: async () => ({
      id: 'local',
      kind,
      title: basename(file),
      storageKey: SOURCE,
      contentType,
    }),
    markSourceDeleted: async () => {},
  },
  procedures: {
    create: async (_c: unknown, p: NewProcedure) => {
      created = p;
      return { id: 'local' } as Procedure;
    },
  },
  ingest: {
    progress: async (_c: unknown, _id: string, stage: string) =>
      console.log(`  ${elapsed()}  ${stage}`),
    finish: async (_c: unknown, _id: string, _p: string, r: unknown) => {
      report = r;
    },
    fail: async (_c: unknown, _id: string, code: string) => {
      failure = code;
    },
    release: async () => {
      failure = 'temporary failure (would be retried)';
    },
  },
} as unknown as DataPlaneStore;

const costs: string[] = [];
const gateway = new ModelGateway(
  new AnthropicProvider(key),
  defaultGatewayConfig('k'.repeat(32)),
  (e) => {
    const ev = e as unknown as Record<string, number | string | undefined>;
    costs.push(
      `${String(ev.model)}: ${String(ev.inputTokens)} in / ${String(ev.outputTokens)} out tokens, ` +
        `cache read ${String(ev.cacheReadTokens ?? 0)}, ${String(ev.latencyMs)} ms, ` +
        `≈ $${(Number(ev.costMicroUsd ?? 0) / 1e6).toFixed(4)} (${String(ev.outcome)})`,
    );
  },
);

console.log(`ingesting ${basename(file)} (${kind}, speech: ${process.env.TRANSCRIBER ?? 'none'})`);
await runIngestJob(
  {
    store,
    storage,
    planes: {
      resolve: async () => ({
        tenantId: TENANT,
        firebaseTenantId: '',
        endpoint: '',
        bucket: 'local',
        keyRef: '',
        region: '',
      }),
    },
    gateway,
    transcriber:
      process.env.TRANSCRIBER === 'google'
        ? new GoogleSpeechTranscriber({ projectId: process.env.GOOGLE_CLOUD_PROJECT })
        : new NoTranscriber(),
    log: (msg, f) => console.log(`  [${msg}]`, JSON.stringify(f ?? {})),
  },
  {
    id: 'local',
    tenantId: TENANT,
    ownerId: TENANT,
    documentId: 'local',
    language,
    outputLanguage: 'English',
    attempts: 3,
  },
);

console.log(`\nfinished in ${elapsed()}${failure ? ` — FAILED: ${failure}` : ''}`);
for (const c of costs) console.log(`model call: ${c}`);

const proc = created as NewProcedure | null;
if (proc) {
  console.log(`\n"${proc.title}"  (${proc.apps.map((a) => a.name).join(', ')})`);
  for (const s of proc.steps) {
    const t = s.target;
    const input = s.input === undefined ? '' : `  input=${JSON.stringify(s.input)}`;
    console.log(`  ${s.id} [${s.action}] ${s.instruction}${input}`);
    if (t)
      console.log(
        `       target: "${t.text ?? ''}" (${t.role ?? '?'})${t.exemplar ? ' +image' : ''}`,
      );
  }
  if (proc.variables.length)
    console.log('variables:', proc.variables.map((v) => v.name).join(', '));
  console.log('\nreport:', JSON.stringify(report, null, 1));
  // Save the guide and its example images for a closer look.
  const out = join(
    resolve(import.meta.dirname, '../../../test-data/out'),
    basename(file, extname(file)),
  );
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'procedure.json'), JSON.stringify({ ...proc, report }, null, 2));
  for (const [k, v] of objects)
    if (k.includes('/exemplars/')) writeFileSync(join(out, basename(k)), v);
  console.log(`saved to ${out}`);
}
