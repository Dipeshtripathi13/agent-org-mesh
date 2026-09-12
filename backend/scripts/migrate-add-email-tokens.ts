import pg from 'pg';
import { sslForConnectionString } from '../src/db/sslConfig.js';

/**
 * Additive, idempotent migration for mandatory email verification and self-service password
 * reset — `email_tokens` and `accounts.email_verification_required`, mirroring
 * backend/db/schema.sql. Existing accounts get `false` (not required), so nobody already using
 * the product is locked out. Run BEFORE deploying the code that reads these:
 *
 *   railway ssh 'cd /app/backend && TARGET_URL="$DATABASE_ADMIN_URL" npx tsx scripts/migrate-add-email-tokens.ts'
 */

const url = process.env.TARGET_URL ?? process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('Set TARGET_URL (or DATABASE_ADMIN_URL) to the schema owner connection string.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: sslForConnectionString(url) });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verification_required boolean NOT NULL DEFAULT false');
  await client.query(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      id          uuid PRIMARY KEY,
      account_id  integer NOT NULL REFERENCES accounts(id),
      purpose     text NOT NULL CHECK (purpose IN ('verify', 'reset')),
      email       text NOT NULL,
      token_hash  text NOT NULL UNIQUE,
      created_at  timestamptz NOT NULL,
      expires_at  timestamptz NOT NULL,
      used_at     timestamptz
    )`);
  await client.query('CREATE INDEX IF NOT EXISTS email_tokens_account_idx ON email_tokens(account_id, purpose)');
  await client.query('GRANT SELECT, INSERT, UPDATE ON email_tokens TO mesh_app');
  await client.query('COMMIT');

  const { rows } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'email_verification_required') AS required_column,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'email_tokens') AS tokens_table,
      (SELECT count(*)::int FROM accounts WHERE email_verification_required) AS accounts_requiring_verification,
      has_table_privilege('mesh_app', 'email_tokens', 'INSERT') AS app_can_insert,
      has_table_privilege('mesh_app', 'email_tokens', 'DELETE') AS app_can_delete`);
  console.log('migrated:', JSON.stringify(rows[0]));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
