import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The 90-day activity retention the privacy policy promises, against the real schema and the
 *  real app role (which must be allowed to delete these rows — migration 0002 — and nothing else). */

let pool: Pool;
let retention: typeof import('./retention.js');
let accountId: number;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-12T12:00:00Z');

beforeAll(async () => {
  ({ pool } = await import('./pool.js'));
  retention = await import('./retention.js');
  accountId = (await pool.query("SELECT id FROM accounts WHERE email = 'jordan@agentorgmesh.local'")).rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM ingested_events WHERE summary LIKE 'retention-test%'");
  await pool.query("DELETE FROM account_ingested_events WHERE summary LIKE 'retention-test%'");
  await pool.end();
});

const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

async function seed(label: string, daysAgo: number) {
  await pool.query(
    'INSERT INTO ingested_events (id, person_id, source, kind, summary, occurred_at) VALUES ($1, 11, $2, $3, $4, $5)',
    [randomUUID(), 'codex', 'action', `retention-test ${label}`, at(daysAgo)],
  );
  await pool.query(
    'INSERT INTO account_ingested_events (id, account_id, source, kind, summary, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), accountId, 'codex', 'action', `retention-test ${label}`, at(daysAgo)],
  );
}

const remaining = async (table: string) =>
  (await pool.query(`SELECT summary FROM ${table} WHERE summary LIKE 'retention-test%' ORDER BY summary`)).rows.map((r) => r.summary);

describe('activity retention', () => {
  it('deletes pushed activity older than 90 days and keeps everything newer', async () => {
    await seed('a-kept-1-day', 1);
    await seed('b-kept-89-days', 89);
    await seed('c-deleted-91-days', 91);
    await seed('d-deleted-400-days', 400);

    const result = await retention.purgeExpiredActivity(NOW);
    expect(result.cutoff).toBe(at(90));
    expect(result.personEvents).toBeGreaterThanOrEqual(2);
    expect(result.accountEvents).toBeGreaterThanOrEqual(2);

    for (const table of ['ingested_events', 'account_ingested_events']) {
      expect(await remaining(table)).toEqual(['retention-test a-kept-1-day', 'retention-test b-kept-89-days']);
    }
  });

  it('is safe to run again', async () => {
    const again = await retention.purgeExpiredActivity(NOW);
    expect(again).toMatchObject({ personEvents: 0, accountEvents: 0 });
  });

  it('the app role can delete activity rows but still cannot delete anything it never could', async () => {
    const { rows } = await pool.query(`
      SELECT has_table_privilege('mesh_app', 'ingested_events', 'DELETE') AS person_events,
             has_table_privilege('mesh_app', 'account_ingested_events', 'DELETE') AS account_events,
             has_table_privilege('mesh_app', 'audit_log', 'DELETE') AS audit_log,
             has_table_privilege('mesh_app', 'policy_revisions', 'DELETE') AS policy_revisions`);
    expect(rows[0]).toEqual({ person_events: true, account_events: true, audit_log: false, policy_revisions: false });
  });

  it('is recorded as migration 0002', async () => {
    // The ledger belongs to the schema owner; the app role deliberately can't read it.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
    await admin.connect();
    try {
      const { rows } = await admin.query("SELECT version FROM schema_migrations WHERE name = 'activity_retention'");
      expect(rows).toEqual([{ version: 2 }]);
    } finally {
      await admin.end();
    }
    await expect(pool.query('SELECT 1 FROM schema_migrations')).rejects.toThrow(/permission denied/);
  });
});
