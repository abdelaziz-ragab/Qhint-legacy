import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,services,packages,scripts}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/*.db.test.ts'],
    environment: 'node',
  },
});
