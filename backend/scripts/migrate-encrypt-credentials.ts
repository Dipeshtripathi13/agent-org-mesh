import pg from 'pg';
import { sslForConnectionString } from '../src/db/sslConfig.js';
import {
  assertCredentialKeyUsable,
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from '../src/domain/credentials.js';

/**
 * Encrypts every plaintext credential in person_oauth_tokens and account_oauth_tokens
 * (release audit SEC-10). Idempotent: already-encrypted values are left alone. One
 * transaction; each new value is decrypted and compared with the original before anything
 * commits. Run AFTER deploying the code that reads encrypted values — the old code would hand
 * ciphertext to connectors as if it were a token.
 *
 *   TARGET_URL=... CREDENTIAL_ENCRYPTION_KEY=... npx tsx scripts/migrate-encrypt-credentials.ts --dry-run
 *   railway ssh 'cd /app/backend && npx tsx scripts/migrate-encrypt-credentials.ts'
 *
 * Needs the same CREDENTIAL_ENCRYPTION_KEY the app runs with; mesh_app's UPDATE grant on both
 * tables is enough, so DATABASE_URL works.
 */

const url = process.env.TARGET_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set TARGET_URL or DATABASE_URL.');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
assertCredentialKeyUsable();

const TABLES = [
  { table: 'person_oauth_tokens', owner: 'person_id' },
  { table: 'account_oauth_tokens', owner: 'account_id' },
] as const;

const client = new pg.Client({ connectionString: url, ssl: sslForConnectionString(url) });
await client.connect();
try {
  await client.query('BEGIN');
  const summary: Record<string, { rows: number; converted: number; plaintextAfter: number }> = {};
  for (const { table, owner } of TABLES) {
    const { rows } = await client.query(
      `SELECT ${owner} AS owner, provider, access_token, refresh_token FROM ${table} FOR UPDATE`,
    );
    let converted = 0;
    for (const row of rows) {
      const encryptAccess = !isEncryptedCredential(row.access_token);
      const encryptRefresh = row.refresh_token != null && !isEncryptedCredential(row.refresh_token);
      if (!encryptAccess && !encryptRefresh) continue;

      const access = encryptAccess ? encryptCredential(row.access_token) : row.access_token;
      const refresh = encryptRefresh ? encryptCredential(row.refresh_token) : row.refresh_token;
      if (decryptCredential(access) !== decryptCredential(row.access_token)
        || (row.refresh_token != null && decryptCredential(refresh) !== decryptCredential(row.refresh_token))) {
        throw new Error(`round-trip mismatch for ${table} ${owner}=${row.owner} provider=${row.provider}`);
      }
      await client.query(
        `UPDATE ${table} SET access_token = $1, refresh_token = $2 WHERE ${owner} = $3 AND provider = $4`,
        [access, refresh, row.owner, row.provider],
      );
      converted += 1;
    }
    const { rows: left } = await client.query(
      `SELECT count(*)::int AS n FROM ${table}
       WHERE access_token NOT LIKE 'enc:v1:%' OR (refresh_token IS NOT NULL AND refresh_token NOT LIKE 'enc:v1:%')`,
    );
    summary[table] = { rows: rows.length, converted, plaintextAfter: left[0].n };
  }
  await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  console.log(JSON.stringify({ dryRun, committed: !dryRun, ...summary }));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
