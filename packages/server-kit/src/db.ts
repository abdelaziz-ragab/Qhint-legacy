import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * Connection pool + Kysely instance. The database location is only a connection string, so
 * moving from the self-hosted VM to Cloud SQL (or a per-customer data plane) is configuration.
 */
export function createDb<DB>(connectionString: string, opts: { max?: number } = {}): Kysely<DB> {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    // Fail fast instead of hanging requests when the database is unreachable.
    connectionTimeoutMillis: 5_000,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
