import { describe, expect, it } from 'vitest';
import { checksum, planMigrations } from './migrations';

const f = (name: string, sql = `-- ${name}`) => ({ name, sql });
const applied = (name: string, sql = `-- ${name}`) => ({ name, checksum: checksum(sql) });

describe('planMigrations', () => {
  it('returns all files in order when nothing is applied', () => {
    const plan = planMigrations([f('0002_b.sql'), f('0001_a.sql')], []);
    expect(plan.map((p) => p.name)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('skips applied migrations', () => {
    const plan = planMigrations([f('0001_a.sql'), f('0002_b.sql')], [applied('0001_a.sql')]);
    expect(plan.map((p) => p.name)).toEqual(['0002_b.sql']);
  });

  it('rejects edited applied migrations', () => {
    expect(() => planMigrations([f('0001_a.sql', 'changed')], [applied('0001_a.sql')])).toThrow(
      /was modified/,
    );
  });

  it('rejects deleted applied migrations', () => {
    expect(() => planMigrations([], [applied('0001_a.sql')])).toThrow(/missing from disk/);
  });

  it('rejects new migrations that sort before applied ones', () => {
    expect(() =>
      planMigrations([f('0001_a.sql'), f('0003_c.sql')], [applied('0003_c.sql')]),
    ).toThrow(/sorts before/);
  });

  it('rejects malformed names', () => {
    expect(() => planMigrations([f('init.sql')], [])).toThrow(/bad migration file name/);
  });
});
