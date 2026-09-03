/**
 * One-off, additive migration: the account_custom_agents table.
 *
 * schema.sql is a full reset (DROP SCHEMA ... CASCADE), and migrate.ts deliberately
 * refuses to run it against a database that already has organizations — so a table added
 * to a live deployment has to be applied by hand, exactly as schema.sql's own header asks
 * for. This is that statement, kept as a script rather than typed into a shell once, so
 * what ran against production is reviewable in the repo (same pattern as
 * migrate-add-must-change-password.ts).
 *
 * Idempotent (CREATE TABLE/INDEX IF NOT EXISTS) and safe to re-run. New/empty databases
 * don't need it at all — schema.sql already declares the table.
 *
 *   TARGET_URL=<admin connection string> npx tsx scripts/migrate-add-account-custom-agents.ts
 *
 * Against Railway, where the database is only reachable from inside the private network:
 *   railway ssh 'cd /app/backend && TARGET_URL="$DATABASE_ADMIN_URL" npx tsx scripts/migrate-add-account-custom-agents.ts'
 */
import pg from 'pg';
import { sslForConnectionString } from '../src/db/sslConfig.js';

const url = process.env.TARGET_URL ?? process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('TARGET_URL (or DATABASE_ADMIN_URL) is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: sslForConnectionString(url) });
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS account_custom_agents (
      id            uuid PRIMARY KEY,
      account_id    integer NOT NULL REFERENCES accounts(id),
      source_key    text NOT NULL UNIQUE,
      name          text NOT NULL,
      purpose       text NOT NULL,
      created_at    timestamptz NOT NULL
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS account_custom_agents_account_idx ON account_custom_agents(account_id)');
  await client.query('GRANT SELECT, INSERT, DELETE ON account_custom_agents TO mesh_app');

  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'account_custom_agents'`,
  );
  const { rows: counts } = await client.query('SELECT count(*)::int AS agents FROM account_custom_agents');
  console.log('table  :', JSON.stringify(rows[0] ?? null));
  console.log('rows   :', JSON.stringify(counts[0]));
  console.log('migrated: account_custom_agents present');
} finally {
  await client.end();
}
