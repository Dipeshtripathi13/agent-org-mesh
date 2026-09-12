import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** SEC-10 against the real schema: what lands in person_oauth_tokens/account_oauth_tokens is
 *  ciphertext, and every reader still gets the original credential back. */

let pool: Pool;
let repo: typeof import('./db/repo.js');
let accountId: number;
const PERSON = 12;
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

beforeAll(async () => {
  ({ pool } = await import('./db/pool.js'));
  repo = await import('./db/repo.js');
  accountId = (await pool.query("SELECT id FROM accounts WHERE email = 'jordan@agentorgmesh.local'")).rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM person_oauth_tokens WHERE person_id = $1 AND provider LIKE 'sec10-%'", [PERSON]);
  await pool.query("DELETE FROM account_oauth_tokens WHERE account_id = $1 AND provider LIKE 'sec10-%'", [accountId]);
  await pool.end();
});

const raw = async (table: string, owner: string, id: number, provider: string) =>
  (await pool.query(`SELECT access_token, refresh_token FROM ${table} WHERE ${owner} = $1 AND provider = $2`, [id, provider])).rows[0];

describe('tool credentials are encrypted at rest', () => {
  it('person connection: raw row is ciphertext, reads return the original', async () => {
    await repo.saveOAuthConnection(PERSON, {
      provider: 'sec10-person', accessToken: 'ghp_PLAINTEXT_ACCESS_1234', refreshToken: 'PLAINTEXT_REFRESH_5678',
      expiresAt: FAR_FUTURE, connectedEmail: 'sec10',
    });
    const row = await raw('person_oauth_tokens', 'person_id', PERSON, 'sec10-person');
    expect(row.access_token).toMatch(/^enc:v1:/);
    expect(row.refresh_token).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain('PLAINTEXT');

    const conn = await repo.getOAuthConnection(PERSON, 'sec10-person');
    expect(conn?.accessToken).toBe('ghp_PLAINTEXT_ACCESS_1234');
    expect(conn?.refreshToken).toBe('PLAINTEXT_REFRESH_5678');
  });

  it('an update without a refresh token keeps the stored one decryptable', async () => {
    await repo.saveOAuthConnection(PERSON, {
      provider: 'sec10-person', accessToken: 'ghp_ROTATED_ACCESS', refreshToken: null,
      expiresAt: FAR_FUTURE, connectedEmail: 'sec10',
    });
    const conn = await repo.getOAuthConnection(PERSON, 'sec10-person');
    expect(conn?.accessToken).toBe('ghp_ROTATED_ACCESS');
    expect(conn?.refreshToken).toBe('PLAINTEXT_REFRESH_5678');
  });

  it('personal account connection: same guarantee', async () => {
    await repo.saveAccountOAuthConnection(accountId, {
      provider: 'sec10-account', accessToken: 'apiKey:PLAINTEXT_TRELLO_TOKEN', refreshToken: null,
      expiresAt: FAR_FUTURE, connectedEmail: 'sec10', siteUrl: 'https://example.test',
    });
    const row = await raw('account_oauth_tokens', 'account_id', accountId, 'sec10-account');
    expect(row.access_token).toMatch(/^enc:v1:/);
    expect(row.access_token).not.toContain('PLAINTEXT');
    expect(row.refresh_token).toBeNull();
    expect((await repo.getAccountOAuthConnection(accountId, 'sec10-account'))?.accessToken).toBe('apiKey:PLAINTEXT_TRELLO_TOKEN');
  });

  it('a legacy plaintext row written before the migration still reads correctly', async () => {
    await pool.query(
      `INSERT INTO person_oauth_tokens (person_id, provider, access_token, refresh_token, expires_at, connected_email, updated_at)
       VALUES ($1, 'sec10-legacy', 'lin_api_LEGACY_PLAINTEXT', NULL, $2, 'sec10', now())`,
      [PERSON, FAR_FUTURE],
    );
    expect((await repo.getOAuthConnection(PERSON, 'sec10-legacy'))?.accessToken).toBe('lin_api_LEGACY_PLAINTEXT');
  });
});
