import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BACKEND_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Creates (if needed), resets and seeds the disposable database the API suite runs against.
 *  Both scripts it runs are destructive, so it refuses any database whose name doesn't end in
 *  `_test` — a mistyped TEST_DATABASE_ADMIN_URL must never reach dev or production data. */
export default async function setup(): Promise<void> {
  // Global setup runs in the main process, where vitest.api.config.ts's `test.env` isn't
  // applied (that only reaches test workers), so it carries the same default itself.
  const adminUrl =
    process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh_test';
  const target = new URL(adminUrl);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": the API suite only runs against a database named *_test`);
  }

  const maintenance = new URL(adminUrl);
  maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  const env = { ...process.env, DATABASE_ADMIN_URL: adminUrl, CONFIRM_RESET: 'yes', NODE_ENV: 'test' };
  for (const script of ['scripts/migrate.ts', 'scripts/seed-db.ts']) {
    execFileSync('npx', ['tsx', script], { cwd: BACKEND_DIR, env, stdio: 'pipe' });
  }
}
