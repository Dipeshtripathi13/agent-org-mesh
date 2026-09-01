/**
 * One-off, additive migration: accounts.must_change_password.
 *
 * schema.sql is a full reset (DROP SCHEMA ... CASCADE), and migrate.ts deliberately
 * refuses to run it against a database that already has organizations — so a column added
 * to a live deployment has to be applied by hand as its own ALTER, exactly as schema.sql's
 * own header asks for ("a genuinely additive change against a live database ... should be
 * applied by hand as its own ALTER, not by loosening that guard"). This is that ALTER,
 * kept as a script rather than typed into a shell once, so what ran against production is
 * reviewable in the repo.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS) and safe to re-run. New/empty databases don't need
 * it at all — schema.sql already declares the column.
 *
 *   TARGET_URL=<admin connection string> npx tsx scripts/migrate-add-must-change-password.ts
 *
 * Against Railway, where the database is only reachable from inside the private network:
 *   railway ssh 'cd /app/backend && TARGET_URL="$DATABASE_ADMIN_URL" npx tsx scripts/migrate-add-must-change-password.ts'
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
  await client.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false');
  const { rows } = await client.query(
    `SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
     WHERE table_name = 'accounts' AND column_name = 'must_change_password'`,
  );
  const { rows: counts } = await client.query(
    'SELECT count(*)::int AS accounts, count(*) FILTER (WHERE must_change_password)::int AS flagged FROM accounts',
  );
  console.log('column :', JSON.stringify(rows[0] ?? null));
  console.log('rows   :', JSON.stringify(counts[0]));
  console.log('migrated: accounts.must_change_password present');
} finally {
  await client.end();
}
