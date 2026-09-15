import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Admin → Organizations person details (GET /api/organizations/:orgId/people-details).
 * Seed, org 1 "Northbeam": jordan = owner-admin (not in the chart), diego = person 11 (has a
 * login, not an admin), person 12 (Amara) has no login.
 */

interface Detail { personId: number; email: string | null; status: string; lastSignInAt: string | null; adminRole: string | null; invitation: { email: string; emailed: boolean } | null; connectedTools: string[] }

let app: FastifyInstance;
let pool: Pool;
const cookie: Record<string, string> = {};
const outsider = { orgId: 0, personId: 0 };
const URL_ = '/api/organizations/1/people-details';

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;
const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-dev-only' } });
  expect(res.statusCode, res.body).toBe(200);
  return sessionCookie(res);
};

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  cookie.jordan = await login('jordan@agentorgmesh.local');
  cookie.diego = await login('diego@agentorgmesh.local');
  const email = `details-outsider-${Date.now()}@example.test`;
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', remoteAddress: '10.9.7.1', payload: { name: 'Outsider', email, password: 'outsider-pass-1' } });
  expect(signup.statusCode, signup.body).toBe(200);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  cookie.outsider = sessionCookie(signup);
  outsider.orgId = signup.json().organization.id;
  outsider.personId = signup.json().person.id;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('who can see people details', () => {
  it('refuses anonymous callers, members who are not admins, and other organizations', async () => {
    expect((await app.inject({ method: 'GET', url: URL_ })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: URL_, headers: { cookie: cookie.diego } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: URL_, headers: { cookie: cookie.outsider } })).statusCode).toBe(403);
  });
});

describe('what an admin sees', () => {
  it('a person with a login shows their email, that they can sign in, and when they last did', async () => {
    const res = await app.inject({ method: 'GET', url: URL_, headers: { cookie: cookie.jordan } });
    expect(res.statusCode, res.body).toBe(200);
    const diego = (res.json().people as Detail[]).find((p) => p.personId === 11)!;
    expect(diego.email).toBe('diego@agentorgmesh.local');
    expect(diego.status).toBe('active');
    expect(diego.lastSignInAt).not.toBeNull(); // this test signed in as Diego above
    expect(diego.adminRole).toBeNull();
    expect(diego.invitation).toBeNull();
    expect(Array.isArray(diego.connectedTools)).toBe(true);
  });

  it('a person added without an email has no login and no email', async () => {
    const res = await app.inject({ method: 'GET', url: URL_, headers: { cookie: cookie.jordan } });
    const amara = (res.json().people as Detail[]).find((p) => p.personId === 12)!;
    expect(amara.status).toBe('no-login');
    expect(amara.email).toBeNull();
  });

  // In the outsider's own new workspace: seeded Northbeam is already past the starter plan's
  // 10-person limit, so it can't take another person.
  it('a person added with an email shows the invitation email until they accept', async () => {
    const email = `details-invitee-${Date.now()}@example.test`;
    const added = await app.inject({
      method: 'POST', url: `/api/organizations/${outsider.orgId}/people`, headers: { cookie: cookie.outsider },
      payload: { name: 'Invited Person', title: 'Engineer', team: 'Payments', managerId: outsider.personId, agentDeployed: true, email },
    });
    expect(added.statusCode, added.body).toBe(200);
    const personId = added.json().person.id as number;
    const res = await app.inject({ method: 'GET', url: `/api/organizations/${outsider.orgId}/people-details`, headers: { cookie: cookie.outsider } });
    expect(res.statusCode, res.body).toBe(200);
    const owner = (res.json().people as Detail[]).find((p) => p.personId === outsider.personId)!;
    expect(owner.adminRole).toBe('owner');
    expect((res.json().people as Detail[]).some((p) => p.personId === 11)).toBe(false);
    const invited = (res.json().people as Detail[]).find((p) => p.personId === personId)!;
    expect(invited.status).toBe('invited');
    expect(invited.email).toBe(email);
    expect(invited.invitation?.email).toBe(email);
  });

  it('never includes another organization’s people', async () => {
    const res = await app.inject({ method: 'GET', url: URL_, headers: { cookie: cookie.jordan } });
    const ids = (res.json().people as Detail[]).map((p) => p.personId);
    const orgOf = (await pool.query('SELECT DISTINCT org_id FROM people WHERE id = ANY($1)', [ids])).rows.map((r) => r.org_id);
    expect(orgOf).toEqual([1]);
  });
});
