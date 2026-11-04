import { defineConfig } from 'vitest/config';

/** Database tests: need `pnpm infra:up && pnpm db:migrate` (or CI's Postgres service). */
export default defineConfig({
  test: {
    include: ['{apps,services,packages,scripts}/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    // Tests share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
