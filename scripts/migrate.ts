/**
 * Applies plain-SQL migrations from db/migrations/<track>/ in order, one transaction each.
 * Tracks are kept separate because the control plane and data plane can live in different
 * databases later. Local dev only for now; production migrations come with Phase 2.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { assertLocal, DEV } from './lib/dev-env';
import { planMigrations, type AppliedMigration } from './lib/migrations';

const TRACKS = ['control', 'content'] as const;
const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'db', 'migrations');
const LOCK_ID = 727_001; // arbitrary constant for pg_advisory_lock

async function loadFiles(track: string) {
  const dir = join(MIGRATIONS_DIR, track);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql'));
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

async function main() {
  assertLocal('DATABASE_URL', DEV.databaseUrl);
  const client = new pg.Client({ connectionString: DEV.databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        track      text NOT NULL,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (track, name)
      )`);

    for (const track of TRACKS) {
      const { rows } = await client.query<AppliedMigration>(
        'SELECT name, checksum FROM public.schema_migrations WHERE track = $1',
        [track],
      );
      const pending = planMigrations(await loadFiles(track), rows);
      for (const m of pending) {
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (track, name, checksum) VALUES ($1, $2, $3)',
            [track, m.name, m.checksum],
          );
          await client.query('COMMIT');
          console.log(`migrate: applied ${track}/${m.name}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      if (pending.length === 0) console.log(`migrate: ${track} up to date`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('migrate failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
