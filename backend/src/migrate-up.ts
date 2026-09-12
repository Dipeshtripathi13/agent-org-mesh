import pg from 'pg';
import { sslForConnectionString } from './db/sslConfig.js';
import { runMigrations } from './db/migrations.js';

/**
 * Applies pending migrations, then exits. Runs before the server on every start
 * (`npm start`), so a deploy can never serve code ahead of its schema. Non-destructive:
 * unlike scripts/migrate.ts it never drops anything. Needs the schema owner's connection
 * (DATABASE_ADMIN_URL); the app role deliberately can't create or alter tables.
 */

// Production must say which database it migrates; locally the docker-compose default is fine.
const url = process.env.DATABASE_ADMIN_URL
  ?? (process.env.NODE_ENV === 'production' ? undefined : 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh');
if (!url) {
  console.error('migrations: DATABASE_ADMIN_URL is not set — it must be the schema owner connection string');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: sslForConnectionString(url) });
try {
  await client.connect();
  const report = await runMigrations(client);
  console.log(`migrations: ${JSON.stringify(report)}`);
} catch (err) {
  console.error(`migrations: FAILED — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
