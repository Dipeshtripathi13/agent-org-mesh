import { defineConfig } from 'vitest/config';

// Pure unit tests only — no database. vitest 5 would otherwise also collect the compiled
// copies in dist/, and *.api.test.ts needs Postgres (run those with `npm run test:api`).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', 'src/**/*.api.test.ts'],
  },
});
