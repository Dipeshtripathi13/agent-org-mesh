import { defineConfig } from 'vitest/config';

// Route-level tests against a real, disposable Postgres database. The global setup creates,
// migrates and seeds it, and refuses any database whose name doesn't end in `_test`.
export const TEST_DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh_test';
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://mesh_app:mesh_app_dev_only@localhost:5433/agent_org_mesh_test';

export default defineConfig({
  test: {
    include: ['src/**/*.api.test.ts'],
    globalSetup: ['./src/test-support/apiGlobalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
    // Set before any test module imports db/pool.ts, which reads DATABASE_URL at load time.
    // No provider keys: answers fall back to raw authorized data, and nothing calls a model.
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_ADMIN_URL,
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3001/api/oauth/gmail/callback',
    },
  },
});
