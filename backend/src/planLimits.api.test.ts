import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ORGS_PER_ACCOUNT, PLAN_SEATS } from './plans.js';

/**
 * Plan limits (plans.ts): people per organization, and organizations per account. Both are
 * enforced server-side — the seat check and the insert share one transaction, so simultaneous
 * requests can't overshoot (they could before 2026-09-17).
 */

let app: FastifyInstance;
let pool: Pool;
let repo: typeof import('./db/repo.js');
let ip = 0;

/** Simultaneous adds in the race test — at most the pool's own size, or warming it would
 *  wait on a connection that can't be handed out yet. */
const RACERS = 10;

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;

/** A fresh account, its own one-person workspace, and a verified email. */
async function newOwner(label: string): Promise<{ cookie: string; orgId: number; personId: number; accountId: number }> {
  const email = `plan-${label}-${Date.now()}-${++ip}@example.test`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', remoteAddress: `10.20.${ip % 250}.${(ip % 250) + 1}`,
    payload: { name: `Owner ${label}`, email, password: 'plan-limit-pass-1' },
  });
  expect(res.statusCode, res.body).toBe(200);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  return { cookie: sessionCookie(res), orgId: res.json().organization.id, personId: res.json().person.id, accountId: res.json().account.id };
}

const addPerson = (cookie: string, orgId: number, name: string) =>
  app.inject({
    method: 'POST', url: `/api/organizations/${orgId}/people`, headers: { cookie },
    payload: { name, title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true },
  });

const peopleIn = async (orgId: number) =>
  Number((await pool.query('SELECT count(*)::int AS n FROM people WHERE org_id = $1', [orgId])).rows[0].n);

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  repo = await import('./db/repo.js');
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('people per organization', () => {
  const starter = PLAN_SEATS.starter!;

  it('fills exactly to the plan limit, then refuses with a clear message', async () => {
    const owner = await newOwner('fill');
    for (let i = 2; i <= starter; i += 1) {
      const res = await addPerson(owner.cookie, owner.orgId, `Person ${i}`);
      expect(res.statusCode, `adding person ${i}: ${res.body}`).toBe(200);
    }
    expect(await peopleIn(owner.orgId)).toBe(starter);

    const overflow = await addPerson(owner.cookie, owner.orgId, 'One too many');
    expect(overflow.statusCode).toBe(402);
    expect(overflow.json().error).toContain(`${starter} people max`);
    expect(await peopleIn(owner.orgId)).toBe(starter);
  });

  // Deliberately against repo.createPersonWithinSeatLimit rather than the HTTP route: the
  // route's own session and role lookups stagger simultaneous requests by a few milliseconds
  // each, so through app.inject the outcome depends on timing — with the lock removed, this
  // raced (12 people in a 10-seat org) only sometimes. Called directly on a warmed pool it is
  // deterministic: every caller reads the same count, and only the lock stops all of them
  // inserting. Verified both ways before trusting it.
  it('simultaneous adds cannot push an organization past its limit', async () => {
    const owner = await newOwner('race');
    for (let i = 2; i < starter; i += 1) {
      expect((await addPerson(owner.cookie, owner.orgId, `Person ${i}`)).statusCode).toBe(200);
    }
    expect(await peopleIn(owner.orgId)).toBe(starter - 1); // exactly one seat left

    // Connections are opened lazily, and a cold handshake takes far longer than an add's few
    // round trips — unwarmed, each call finishes before the next one's connection is ready and
    // nothing ever overlaps.
    const warm = await Promise.all(Array.from({ length: RACERS }, () => pool.connect()));
    await Promise.all(warm.map((c) => c.query('SELECT 1')));
    warm.forEach((c) => c.release());

    const results = await Promise.all(Array.from({ length: RACERS }, (_, i) =>
      repo.createPersonWithinSeatLimit(owner.orgId, {
        name: `Racer ${i}`, title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true,
      })));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(RACERS - 1);
    expect(await peopleIn(owner.orgId)).toBe(starter);
  });

  it('removing someone frees their seat', async () => {
    const owner = await newOwner('free');
    for (let i = 2; i <= starter; i += 1) {
      expect((await addPerson(owner.cookie, owner.orgId, `Person ${i}`)).statusCode).toBe(200);
    }
    expect((await addPerson(owner.cookie, owner.orgId, 'Blocked')).statusCode).toBe(402);

    const last = (await pool.query('SELECT id FROM people WHERE org_id = $1 ORDER BY id DESC LIMIT 1', [owner.orgId])).rows[0].id;
    await pool.query('DELETE FROM people WHERE id = $1', [last]);

    expect((await addPerson(owner.cookie, owner.orgId, 'Now there is room')).statusCode).toBe(200);
    expect(await peopleIn(owner.orgId)).toBe(starter);
  });

  it('reports the limit alongside the people count, so the UI never hardcodes it', async () => {
    const owner = await newOwner('report');
    const res = await app.inject({ method: 'GET', url: '/api/organizations', headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const org = (res.json().organizations as { id: number; plan: string; peopleCount: number; seatLimit: number | null }[])
      .find((o) => o.id === owner.orgId)!;
    expect(org.plan).toBe('starter');
    expect(org.seatLimit).toBe(starter);
    expect(org.peopleCount).toBe(1);
  });
});

describe('organizations per account', () => {
  it('lets an account create up to the cap, then refuses', async () => {
    const owner = await newOwner('orgs'); // signup already created their first organization
    for (let i = 2; i <= MAX_ORGS_PER_ACCOUNT; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: { cookie: owner.cookie }, payload: { name: `Org ${i}` } });
      expect(res.statusCode, `creating org ${i}: ${res.body}`).toBe(200);
    }
    const tooMany = await app.inject({ method: 'POST', url: '/api/organizations', headers: { cookie: owner.cookie }, payload: { name: 'One too many' } });
    expect(tooMany.statusCode).toBe(402);
    expect(tooMany.json().error).toContain(`${MAX_ORGS_PER_ACCOUNT} organizations`);

    const owned = Number((await pool.query("SELECT count(*)::int AS n FROM org_admins WHERE account_id = $1 AND role = 'owner'", [owner.accountId])).rows[0].n);
    expect(owned).toBe(MAX_ORGS_PER_ACCOUNT);
  });
});
