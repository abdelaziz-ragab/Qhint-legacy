import { createHash } from 'node:crypto';

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export interface PlannedMigration extends MigrationFile {
  checksum: string;
}

const NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Decide which migrations still need to run. Fails if a file name is malformed, if an
 * applied migration was edited or deleted, or if a new file sorts before an applied one.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): PlannedMigration[] {
  for (const f of files) {
    if (!NAME_PATTERN.test(f.name)) {
      throw new Error(`bad migration file name "${f.name}" (expected 0001_name.sql)`);
    }
  }
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(sorted.map((f) => [f.name, f]));

  for (const a of applied) {
    const file = byName.get(a.name);
    if (!file) throw new Error(`applied migration "${a.name}" is missing from disk`);
    if (checksum(file.sql) !== a.checksum) {
      throw new Error(`applied migration "${a.name}" was modified; add a new migration instead`);
    }
  }

  const appliedNames = new Set(applied.map((a) => a.name));
  const lastApplied = [...appliedNames].sort().at(-1);
  const pending = sorted.filter((f) => !appliedNames.has(f.name));
  if (lastApplied && pending.length > 0 && pending[0]!.name < lastApplied) {
    throw new Error(
      `migration "${pending[0]!.name}" sorts before already-applied "${lastApplied}"`,
    );
  }
  return pending.map((f) => ({ ...f, checksum: checksum(f.sql) }));
}
