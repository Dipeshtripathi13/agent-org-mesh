import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The audit chain's order (migration 0009). It used to be inferred from `(created_at, id)`,
 * which ask-multi ties by writing one row per target with a single `now` — so a new row could
 * sort before the row it points at, and the admin screen reported tampering on untouched data
 * (measured 2026-09-27: 3 of 5 runs of one ask-multi about three people).
 */

let app: FastifyInstance;
let pool: Pool;
/** The schema owner. mesh_app deliberately holds no UPDATE on audit_log (rule 2), so altering a
 *  stored row — the thing the chain exists to expose — can only be done from outside the app. */
let admin: Pool;
let ip = 0;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;

async function orgWithReports(count: number) {
  const email = `chain-${Date.now()}-${++ip}@example.test`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', remoteAddress: `10.70.${ip % 250}.${(ip % 250) + 1}`,
    payload: { name: 'Chain Owner', email, password: 'audit-chain-pass-1' },
  });
  expect(res.statusCode, res.body).toBe(200);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  const cookie = cookieOf(res);
  const orgId = res.json().organization.id as number;
  const managerId = res.json().person.id as number;
  const reports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = await app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/people`, headers: { cookie },
      payload: { name: `Report ${i}`, title: 'Engineer', team: 'Eng', managerId, agentDeployed: true },
    });
    expect(p.statusCode, p.body).toBe(200);
    reports.push(p.json().person.id);
  }
  return { cookie, orgId, managerId, reports };
}

const integrityOf = async (cookie: string, orgId: number) => {
  const res = await app.inject({ method: 'GET', url: `/api/audit?orgId=${orgId}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { entries: unknown[]; integrity: { valid: boolean; brokenAt: number | null } };
};

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  admin = new PgPool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL }) as unknown as Pool;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.end();
});

describe('the audit chain reads back in the order it was written', () => {
  // Repeated because the old bug was a coin flip per adjacent pair: the tiebreaker was a random
  // uuid, so a single run passed about half the time even while broken.
  it('survives ask-multi, which writes every row with one shared timestamp', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const { cookie, orgId, reports } = await orgWithReports(3);
      const multi = await app.inject({
        method: 'POST', url: '/api/agent/ask-multi', headers: { cookie },
        payload: { targetIds: reports, role: 'Direct manager', question: 'What are you working on?', persist: true },
      });
      expect(multi.statusCode, multi.body).toBe(200);

      const { entries, integrity } = await integrityOf(cookie, orgId);
      expect(entries.length, `round ${round}`).toBe(3);
      expect(integrity, `round ${round}: one ask-multi must not break the chain`)
        .toEqual({ valid: true, brokenAt: null });

      // The rows really do share a timestamp — otherwise this test isn't exercising the bug.
      const groups = await pool.query(
        'SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 GROUP BY created_at', [orgId]);
      expect(Math.max(...groups.rows.map((r: { n: number }) => r.n))).toBeGreaterThan(1);
    }
  });

  it('gives every row a distinct place in line, in insertion order', async () => {
    const { cookie, orgId, reports } = await orgWithReports(3);
    await app.inject({
      method: 'POST', url: '/api/agent/ask-multi', headers: { cookie },
      payload: { targetIds: reports, role: 'Direct manager', question: 'Status?', persist: true },
    });
    const rows = await pool.query(
      'SELECT seq, prev_hash, row_hash FROM audit_log WHERE org_id = $1 ORDER BY seq', [orgId]);
    expect(rows.rows.length).toBe(3);
    expect(new Set(rows.rows.map((r: { seq: string }) => r.seq)).size).toBe(3);
    // Each row points at the one before it, in exactly this order.
    expect(rows.rows[0].prev_hash).toBeNull();
    expect(rows.rows[1].prev_hash).toBe(rows.rows[0].row_hash);
    expect(rows.rows[2].prev_hash).toBe(rows.rows[1].row_hash);
  });

  it('still catches a row that was actually altered', async () => {
    const { cookie, orgId, managerId } = await orgWithReports(0);
    for (const question of ['First question', 'Second question']) {
      const ask = await app.inject({
        method: 'POST', url: '/api/agent/ask', headers: { cookie },
        payload: { targetId: managerId, role: 'Self', question, persist: true },
      });
      expect(ask.statusCode, ask.body).toBe(200);
    }
    expect((await integrityOf(cookie, orgId)).integrity.valid).toBe(true);

    // Rewrite a stored question, as the schema owner — mesh_app can't, which is the point.
    await admin.query(
      `UPDATE audit_log SET question = 'Something else entirely'
        WHERE org_id = $1 AND seq = (SELECT min(seq) FROM audit_log WHERE org_id = $1)`, [orgId]);

    const after = await integrityOf(cookie, orgId);
    expect(after.integrity.valid).toBe(false);
    expect(after.integrity.brokenAt).toBe(0);
  });
});
