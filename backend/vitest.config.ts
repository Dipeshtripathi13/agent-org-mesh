import { defineConfig } from 'vitest/config';

// Only the TypeScript sources: vitest 5 otherwise also collects the compiled copies in dist/,
// running every test twice against whatever build happened to be left behind.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
