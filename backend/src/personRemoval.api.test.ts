import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Removing someone from a chart (migration 0007). Until 2026-09-20 this was a plain
 * `DELETE FROM people`, which raised a foreign-key error and returned 500 for anyone who had
 * ever been asked about or connected a tool — claims/evidence/escalations/audit_log all
 * reference people(id) and the app role holds no DELETE on any of them. It marks them now:
 * gone from every roster, seat and identity lookup, while their history stays readable.
 */

let app: FastifyInstance;
let pool: Pool;
let ip = 0;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;

async function newOwner(label: string) {
  const email = `remove-${label}-${Date.now()}-${++ip}@example.test`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', remoteAddress: `10.30.${ip % 250}.${(ip % 250) + 1}`,
    payload: { name: `Owner ${label}`, email, password: 'person-removal-pass-1' },
  });
  expect(res.statusCode, res.body).toBe(200);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  // Removing someone is a step-up action, like every other destructive admin write.
  const step = await app.inject({
    method: 'POST', url: '/api/auth/step-up', headers: { cookie: cookieOf(res) },
    payload: { password: 'person-removal-pass-1' },
  });
  expect(step.statusCode, step.body).toBe(200);
  return { cookie: cookieOf(res), orgId: res.json().organization.id as number, personId: res.json().person.id as number };
}

async function addPerson(cookie: string, orgId: number, name: string, managerId: number | null = null) {
  const res = await app.inject({
    method: 'POST', url: `/api/organizations/${orgId}/people`, headers: { cookie },
    payload: { name, title: 'Engineer', team: 'Eng', managerId, agentDeployed: true },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().person.id as number;
}

const remove = (cookie: string, orgId: number, personId: number) =>
  app.inject({ method: 'DELETE', url: `/api/organizations/${orgId}/people/${personId}`, headers: { cookie } });

const rosterIds = async (cookie: string, orgId: number) => {
  const res = await app.inject({ method: 'GET', url: `/api/org?orgId=${orgId}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().people as { id: number }[]).map((p) => p.id);
};

/** A claim is what made the old DELETE fail, so the regression test needs a real one. */
async function giveThemAClaim(orgId: number, personId: number) {
  await pool.query(
    `INSERT INTO claims (id, org_id, person_id, tier, data_class, text, source_surface, derived_at)
     VALUES ($3,$1,$2,'T2','work_status','Opened a pull request','github', now())`,
    [orgId, personId, `claim-removal-${personId}`],
  );
}

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('removing someone from the chart', () => {
  it('works for someone who has real history, and keeps that history', async () => {
    const owner = await newOwner('history');
    const leaver = await addPerson(owner.cookie, owner.orgId, 'Leaver With History');
    await giveThemAClaim(owner.orgId, leaver);

    const res = await remove(owner.cookie, owner.orgId, leaver);
    expect(res.statusCode, res.body).toBe(200); // was 500: foreign key violation

    expect(await rosterIds(owner.cookie, owner.orgId)).not.toContain(leaver);
    const row = (await pool.query('SELECT removed_at FROM people WHERE id = $1', [leaver])).rows[0];
    expect(row, 'their record must survive — history references it').toBeTruthy();
    expect(row.removed_at).not.toBeNull();
    const claims = await pool.query('SELECT count(*)::int AS n FROM claims WHERE person_id = $1', [leaver]);
    expect(claims.rows[0].n).toBe(1);
  });

  it('frees their seat', async () => {
    const owner = await newOwner('seat');
    const leaver = await addPerson(owner.cookie, owner.orgId, 'Leaver');
    await giveThemAClaim(owner.orgId, leaver);

    const before = await app.inject({ method: 'GET', url: '/api/organizations', headers: { cookie: owner.cookie } });
    const countOf = (r: typeof before) =>
      (r.json().organizations as { id: number; peopleCount: number }[]).find((o) => o.id === owner.orgId)!.peopleCount;
    expect(countOf(before)).toBe(2);

    expect((await remove(owner.cookie, owner.orgId, leaver)).statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/organizations', headers: { cookie: owner.cookie } });
    expect(countOf(after)).toBe(1);
  });

  it('ends their access to the organization, and their tools stop reporting into it', async () => {
    const owner = await newOwner('access');
    const leaver = await addPerson(owner.cookie, owner.orgId, 'Leaver With Login');

    // Give them a real login of their own, the way accepting an invitation would.
    const email = `leaver-${Date.now()}-${++ip}@example.test`;
    const signup = await app.inject({
      method: 'POST', url: '/api/auth/signup', remoteAddress: `10.31.${ip % 250}.${(ip % 250) + 1}`,
      payload: { name: 'Leaver With Login', email, password: 'leaver-own-pass-1' },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const leaverCookie = cookieOf(signup);
    const accountId = signup.json().account.id as number;
    await pool.query('UPDATE accounts SET email_verified_at = now() WHERE id = $1', [accountId]);
    await pool.query('UPDATE people SET account_id = $1 WHERE id = $2', [accountId, leaver]);

    // A push token of theirs, and proof it works while they are still in the chart.
    const minted = await app.inject({
      method: 'POST', url: `/api/person/${leaver}/ingest-tokens`, headers: { cookie: leaverCookie },
      payload: { label: 'laptop' },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const token = minted.json().token as string;
    const push = () => app.inject({
      method: 'POST', url: '/api/ingest/claude-code', headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ kind: 'tool_use', summary: 'Edited server.ts', occurredAt: new Date().toISOString() }] },
    });
    expect((await push()).statusCode).toBe(202);
    expect(await rosterIds(leaverCookie, owner.orgId)).toContain(leaver);

    expect((await remove(owner.cookie, owner.orgId, leaver)).statusCode).toBe(200);

    // Their own session is still valid — they just aren't in this organization any more.
    const org = await app.inject({ method: 'GET', url: `/api/org?orgId=${owner.orgId}`, headers: { cookie: leaverCookie } });
    expect(org.statusCode).toBe(403);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: leaverCookie } });
    expect(me.statusCode).toBe(200);
    expect((me.json().people as { orgId: number }[]).some((p) => p.orgId === owner.orgId)).toBe(false);

    // And the token that used to push into this org is dead.
    expect((await push()).statusCode).toBe(401);

    // Removal revokes their tokens, and resolveIngestToken independently refuses anyone who
    // has left. Proved separately by handing the token back its validity: a live token
    // belonging to a removed person must still read as unknown, or the two protections would
    // collapse into one and this one could rot unnoticed.
    await pool.query('UPDATE ingest_tokens SET revoked_at = NULL WHERE person_id = $1', [leaver]);
    expect((await push()).statusCode).toBe(401);
  });

  it('refuses while they still have direct reports', async () => {
    const owner = await newOwner('reports');
    const manager = await addPerson(owner.cookie, owner.orgId, 'Manager');
    const report = await addPerson(owner.cookie, owner.orgId, 'Report', manager);

    const refused = await remove(owner.cookie, owner.orgId, manager);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('direct reports');

    expect((await remove(owner.cookie, owner.orgId, report)).statusCode).toBe(200);
    expect((await remove(owner.cookie, owner.orgId, manager)).statusCode).toBe(200);
  });

  it('cannot be asked about once removed, and says why', async () => {
    const owner = await newOwner('ask');
    const leaver = await addPerson(owner.cookie, owner.orgId, 'Leaver');
    expect((await remove(owner.cookie, owner.orgId, leaver)).statusCode).toBe(200);

    const ask = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: owner.cookie },
      payload: { targetId: leaver, role: 'Direct manager', question: 'What are they working on?' },
    });
    expect(ask.statusCode).toBe(404);
    expect(ask.json().error).toMatch(/no longer in this organization/i);
  });

  it('is refused twice over, and only by an admin', async () => {
    const owner = await newOwner('twice');
    const leaver = await addPerson(owner.cookie, owner.orgId, 'Leaver');
    const outsider = await newOwner('outsider');

    const byOutsider = await remove(outsider.cookie, owner.orgId, leaver);
    expect(byOutsider.statusCode).toBe(403);

    expect((await remove(owner.cookie, owner.orgId, leaver)).statusCode).toBe(200);
    const again = await remove(owner.cookie, owner.orgId, leaver);
    expect(again.statusCode).toBe(409);
  });
});
