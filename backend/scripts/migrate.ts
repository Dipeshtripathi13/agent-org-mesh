import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh';

const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const sql = readFileSync(schemaPath, 'utf8');

const client = new Client({ connectionString: adminUrl });
await client.connect();
try {
  await client.query(sql);
  console.log('migrated: schema applied');
} finally {
  await client.end();
}
