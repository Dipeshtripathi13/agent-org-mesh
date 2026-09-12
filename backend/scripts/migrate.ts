import pg from 'pg';
import { sslForConnectionString } from '../src/db/sslConfig.js';
import { runMigrations } from '../src/db/migrations.js';

/**
 * Destructive reset for dev and test databases: drop the whole schema, then rebuild it by
 * applying every migration in backend/db/migrations. Deployments never use this — they run
 * src/migrate-up.ts, which only applies what's pending.
 */

const { Client } = pg;

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh';

const client = new Client({ connectionString: adminUrl, ssl: sslForConnectionString(adminUrl) });
await client.connect();
try {
  // Pointed at the wrong URL, this would delete every real organization. Refuse to run
  // against anything that already has data unless that's explicitly confirmed — a fresh or
  // empty database (a new dev/qa environment, or a deliberate reset) still proceeds.
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') AS exists`,
  );
  if (rows[0].exists) {
    const { rows: orgRows } = await client.query('SELECT count(*)::int AS n FROM organizations');
    if (orgRows[0].n > 0 && process.env.CONFIRM_RESET !== 'yes') {
      console.error(
        `Refusing to run: ${adminUrl.replace(/:[^:@]*@/, ':***@')} already has ${orgRows[0].n} organization(s).\n` +
          'This script wipes the entire schema. If that\'s really what you want (a genuine dev/qa reset,\n' +
          'never against a database with real signups), re-run with CONFIRM_RESET=yes.',
      );
      process.exitCode = 1;
      throw new Error('aborted: destructive reset not confirmed');
    }
  }
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  const report = await runMigrations(client);
  console.log(`migrated: schema reset, then ${JSON.stringify(report)}`);
} finally {
  await client.end();
}
