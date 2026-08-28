import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslForConnectionString } from '../src/db/sslConfig.js';

const { Client } = pg;

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh';

const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const sql = readFileSync(schemaPath, 'utf8');

const client = new Client({ connectionString: adminUrl, ssl: sslForConnectionString(adminUrl) });
await client.connect();
try {
  // schema.sql opens with DROP SCHEMA public CASCADE — a full reset, not an incremental
  // migration. That was safe by default while nothing pointed at by DATABASE_ADMIN_URL
  // held real data. It stopped being safe the moment this app had a real prod deployment
  // with real signups behind it: this exact script, pointed at the wrong URL, would
  // silently delete every real organization. Refuse to run against anything that
  // already has data unless that's explicitly confirmed — a fresh/empty database (a new
  // dev/qa environment, or a genuinely intentional reset after CONFIRM_RESET) still
  // proceeds with zero extra friction.
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
  await client.query(sql);
  console.log('migrated: schema applied');
} finally {
  await client.end();
}
