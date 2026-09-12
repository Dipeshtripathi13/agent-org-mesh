import pg from 'pg';
import { sslForConnectionString } from '../src/db/sslConfig.js';

/**
 * Additive, idempotent migration for release audit SEC-08 — the `invitations` table and
 * `accounts.email_verified_at`, mirroring backend/db/schema.sql. schema.sql itself is a full
 * reset and must never run against real data. Run BEFORE deploying the code that reads these:
 *
 *   railway ssh 'cd /app/backend && TARGET_URL="$DATABASE_ADMIN_URL" npx tsx scripts/migrate-add-invitations.ts'
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
  await client.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamptz');
  await client.query(`
    CREATE TABLE IF NOT EXISTS invitations (
      id           uuid PRIMARY KEY,
      org_id       integer NOT NULL REFERENCES organizations(id),
      email        text NOT NULL,
      kind         text NOT NULL CHECK (kind IN ('person', 'admin')),
      person_id    integer REFERENCES people(id) ON DELETE CASCADE,
      admin_role   text CHECK (admin_role IN ('owner', 'admin', 'viewer')),
      token_hash   text NOT NULL UNIQUE,
      invited_by   integer NOT NULL REFERENCES accounts(id),
      created_at   timestamptz NOT NULL,
      expires_at   timestamptz NOT NULL,
      emailed_at   timestamptz,
      accepted_at  timestamptz,
      accepted_by  integer REFERENCES accounts(id),
      revoked_at   timestamptz,
      CHECK ((kind = 'person' AND person_id IS NOT NULL) OR (kind = 'admin' AND admin_role IS NOT NULL))
    )`);
  await client.query('CREATE INDEX IF NOT EXISTS invitations_org_idx ON invitations(org_id)');
  await client.query('GRANT SELECT, INSERT, UPDATE ON invitations TO mesh_app');
  await client.query('COMMIT');

  const { rows } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'email_verified_at') AS verified_column,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'invitations') AS invitations_table,
      has_table_privilege('mesh_app', 'invitations', 'INSERT') AS app_can_insert,
      has_table_privilege('mesh_app', 'invitations', 'DELETE') AS app_can_delete`);
  console.log('migrated:', JSON.stringify(rows[0]));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
