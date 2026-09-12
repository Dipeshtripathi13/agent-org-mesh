import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Route × caller authorization table (release audit OPS-02). Every critical finding in that
 * audit — anonymous asks as the CEO, Executive previews by repeating an id, public rosters and
 * disclosure history, tokens minted for other people — was an authorization gap no unit test
 * could see, because none of them ever reached a route. This drives the real app against a
 * seeded, disposable database and pins who gets what.
 *
 * Seed (scripts/seed-db.ts), org 1 "Northbeam":
 *   diego  — person 11, Staff Engineer (the "self" in most rows)
 *   marta  — person 1, CEO (a real Executive for everyone in the org)
 *   jordan — owner-admin of org 1, not a person in its chart
 *   outsider — a fresh signup with its own one-person org, no relation to Northbeam
 *   person 12 (Amara) has no login at all.
 * No provider keys are configured, so asks never call a model and nothing here is persisted.
 */

type Caller = 'anon' | 'outsider' | 'diego' | 'marta' | 'jordan';
const CALLERS: Caller[] = ['anon', 'outsider', 'diego', 'marta', 'jordan'];

interface Case {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string | (() => string);
  payload?: unknown;
  expect: Partial<Record<Caller, number>>;
}

let app: FastifyInstance;
let pool: Pool;
const cookie: Partial<Record<Caller, string>> = {};
const ids = { escalation: '', otherClaim: '' };

async function sessionCookie(res: { cookies: { name: string; value: string }[] }): Promise<string> {
  const c = res.cookies.find((x) => x.name === 'aom_session');
  if (!c) throw new Error('no session cookie in response');
  return `aom_session=${c.value}`;
}

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-dev-only' } });
  expect(res.statusCode, res.body).toBe(200);
  return sessionCookie(res);
}

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  cookie.diego = await login('diego@agentorgmesh.local');
  cookie.marta = await login('marta@agentorgmesh.local');
  cookie.jordan = await login('jordan@agentorgmesh.local');
  const outsiderEmail = `outsider-${Date.now()}@example.test`;
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { name: 'Outsider', email: outsiderEmail, password: 'outsider-pass-1' },
  });
  expect(signup.statusCode, signup.body).toBe(200);
  cookie.outsider = await sessionCookie(signup);
  // Signups must verify their email before using anything (email.api.test.ts covers that
  // gate); this table is about authorization, so the outsider is a verified account.
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [outsiderEmail]);

  ids.escalation = (await pool.query("SELECT id FROM escalations WHERE org_id = 1 AND status <> 'resolved' LIMIT 1")).rows[0].id;
  ids.otherClaim = (await pool.query('SELECT id FROM claims WHERE org_id = 1 AND person_id <> 11 LIMIT 1')).rows[0].id;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const selfOnly = { anon: 401, outsider: 403, marta: 403, jordan: 403, diego: 200 };
const membersAndAdmins = { anon: 401, outsider: 403, diego: 200, marta: 200, jordan: 200 };
const adminsOnly = { anon: 401, outsider: 403, diego: 403, marta: 403, jordan: 200 };

const CASES: Case[] = [
  // SEC-04 — org-scoped reads: members and admins of this org only
  { name: 'roster', method: 'GET', url: '/api/org?orgId=1', expect: membersAndAdmins },
  { name: 'roster with no orgId', method: 'GET', url: '/api/org', expect: { anon: 401, diego: 403, jordan: 403 } },
  { name: 'policy grid', method: 'GET', url: '/api/policy?orgId=1', expect: membersAndAdmins },
  { name: 'org main agent', method: 'GET', url: '/api/organizations/1/main-agent', expect: membersAndAdmins },

  // SEC-03 — disclosure history (non-subjects get only their own rows; see the test below)
  { name: 'audit about Diego', method: 'GET', url: '/api/audit/subject/11', expect: membersAndAdmins },

  // SEC-05 — self-service records: exactly the person, nobody else
  { name: "Diego's raw record", method: 'GET', url: '/api/person/11', expect: selfOnly },
  { name: "Diego's export", method: 'GET', url: '/api/person/11/export', expect: selfOnly },
  { name: "Diego's connectors", method: 'GET', url: '/api/person/11/connectors', expect: selfOnly },
  { name: "Diego's runtimes", method: 'GET', url: '/api/person/11/runtimes', expect: selfOnly },
  { name: "Diego's ingest tokens", method: 'GET', url: '/api/person/11/ingest-tokens', expect: selfOnly },
  { name: 'conversations about Diego', method: 'GET', url: '/api/agent/conversations?targetId=11', expect: { anon: 401, outsider: 403, jordan: 403, diego: 200 } },
  {
    name: 'mint ingest token for login-less Amara',
    method: 'POST', url: '/api/person/12/ingest-tokens', payload: { label: 'authz-test' },
    expect: { anon: 401, outsider: 403, diego: 403, marta: 403, jordan: 403 },
  },
  {
    name: 'cycle a surface for Amara',
    method: 'POST', url: '/api/person/12/surface/cycle', payload: { surfaceKey: 'github' },
    expect: { anon: 401, outsider: 403, diego: 403, jordan: 403 },
  },
  {
    name: 'connect a tool for Amara',
    method: 'POST', url: '/api/person/12/connectors/linear', payload: { apiKey: 'lin_api_test' },
    expect: { anon: 401, outsider: 403, diego: 403, jordan: 403 },
  },
  { name: 'Gmail OAuth start for Amara', method: 'GET', url: '/api/oauth/gmail/start?personId=12', expect: { anon: 401, outsider: 403, diego: 403 } },
  {
    name: "correct someone else's claim",
    method: 'POST', url: () => `/api/claim/${ids.otherClaim}/correct`, payload: { note: 'authz-test' },
    expect: { anon: 401, outsider: 403, diego: 403, jordan: 403 },
  },

  // SEC-01 / SEC-02 — who is asking comes from the session, and the role must be true
  {
    name: 'preview Diego at Executive tier',
    method: 'POST', url: '/api/query', payload: { targetId: 11, role: 'Executive' },
    expect: { anon: 401, outsider: 403, diego: 200, marta: 403, jordan: 200 },
  },
  {
    name: 'ask about Diego as Executive',
    method: 'POST', url: '/api/agent/ask', payload: { targetId: 11, role: 'Executive', question: 'What is he working on?' },
    expect: { anon: 401, outsider: 403, diego: 403, marta: 200, jordan: 403 },
  },
  {
    name: 'ask about Diego as Self',
    method: 'POST', url: '/api/agent/ask', payload: { targetId: 11, role: 'Self', question: 'What did I do?' },
    expect: { anon: 401, diego: 200, marta: 403 },
  },
  {
    name: 'ask several people as Executive',
    method: 'POST', url: '/api/agent/ask-multi', payload: { targetIds: [11, 10], role: 'Executive', question: 'Status?' },
    expect: { anon: 401, outsider: 403, jordan: 403, marta: 200 },
  },

  // Admin surface — viewer+ for reads, elevation for sensitive writes
  { name: 'overview', method: 'GET', url: '/api/overview?orgId=1', expect: adminsOnly },
  { name: 'org audit log', method: 'GET', url: '/api/audit?orgId=1', expect: adminsOnly },
  { name: 'escalations', method: 'GET', url: '/api/escalations?orgId=1', expect: adminsOnly },
  { name: 'connections', method: 'GET', url: '/api/connections?orgId=1', expect: adminsOnly },
  { name: 'org admins', method: 'GET', url: '/api/organizations/1/admins', expect: adminsOnly },
  {
    name: 'edit policy (needs fresh password)',
    method: 'POST', url: '/api/policy/cycle?orgId=1', payload: { role: 'Peer', dataClass: 'Open' },
    expect: { anon: 401, outsider: 403, diego: 403, jordan: 428 },
  },
  {
    name: 'remove a person (needs fresh password)',
    method: 'DELETE', url: '/api/organizations/1/people/12',
    expect: { anon: 401, outsider: 403, diego: 403, jordan: 428 },
  },
  {
    name: 'add a person',
    method: 'POST', url: '/api/organizations/1/people', payload: { name: 'Authz Test', title: 'T', team: 'X' },
    expect: { anon: 401, outsider: 403, diego: 403 },
  },
  {
    name: 'acknowledge an escalation without a place in the chart',
    method: 'POST', url: () => `/api/escalations/${ids.escalation}/acknowledge`,
    expect: { anon: 401, outsider: 403, jordan: 403 },
  },

  // Personal account surface — any logged-in account, only its own data
  { name: 'my personal connectors', method: 'GET', url: '/api/accounts/me/connectors', expect: { anon: 401, outsider: 200, diego: 200 } },

  // Anonymous callers can't tell which ids exist
  { name: 'nonexistent person', method: 'GET', url: '/api/person/999999/connectors', expect: { anon: 401, diego: 404 } },
  { name: 'nonexistent audit subject', method: 'GET', url: '/api/audit/subject/999999', expect: { anon: 401, diego: 404 } },
];

describe.each(CASES)('$name', (c) => {
  for (const caller of CALLERS) {
    const want = c.expect[caller];
    if (want === undefined) continue;
    it(`${caller} → ${want}`, async () => {
      const res = await app.inject({
        method: c.method,
        url: typeof c.url === 'function' ? c.url() : c.url,
        payload: c.payload as never,
        headers: caller === 'anon' ? {} : { cookie: cookie[caller]! },
      });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(want);
    });
  }
});

describe('audit about someone else is limited to your own requests', () => {
  it("Marta sees only rows she asked; Diego (subject) and Jordan (admin) see every row", async () => {
    const asked = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: cookie.marta! },
      payload: { targetId: 11, role: 'Executive', question: 'authz-test persisted ask', persist: true },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const total = Number((await pool.query('SELECT count(*) FROM audit_log WHERE target_person_id = 11')).rows[0].count);
    const byMarta = Number((await pool.query('SELECT count(*) FROM audit_log WHERE target_person_id = 11 AND requester_id = 1')).rows[0].count);
    const read = async (who: Caller) =>
      (await app.inject({ method: 'GET', url: '/api/audit/subject/11', headers: { cookie: cookie[who]! } })).json().entries as { requesterId: number }[];

    const marta = await read('marta');
    expect(marta).toHaveLength(byMarta);
    expect(marta.every((e) => e.requesterId === 1)).toBe(true);
    expect(await read('diego')).toHaveLength(total);
    expect(await read('jordan')).toHaveLength(total);
  });

  it('a persisted ask is attributed to the session, never a requesterId in the body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: cookie.marta! },
      payload: { targetId: 11, role: 'Executive', question: 'authz-test attribution', persist: true, requesterId: 11 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await pool.query(
      "SELECT requester_id FROM audit_log WHERE question = 'authz-test attribution' ORDER BY created_at DESC LIMIT 1",
    )).rows[0];
    expect(row.requester_id).toBe(1);
  });
});

describe('input is validated before any handler runs', () => {
  it('rejects a policy edit that targets Object.prototype', async () => {
    const before = Number((await pool.query('SELECT count(*) FROM policy_revisions WHERE org_id = 1')).rows[0].count);
    const res = await app.inject({
      method: 'POST', url: '/api/policy/cycle?orgId=1', headers: { cookie: cookie.jordan! },
      payload: { role: '__proto__', dataClass: 'polluted' },
    });
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Number((await pool.query('SELECT count(*) FROM policy_revisions WHERE org_id = 1')).rows[0].count)).toBe(before);
  });

  it('rejects non-numeric and out-of-range person ids', async () => {
    for (const bad of ['abc', '-1', '99999999999']) {
      const res = await app.inject({ method: 'GET', url: `/api/person/${bad}/connectors`, headers: { cookie: cookie.diego! } });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('refuses a manager from another organization', async () => {
    const other = (await pool.query('SELECT id FROM people WHERE org_id <> 1 ORDER BY id LIMIT 1')).rows[0].id;
    const res = await app.inject({
      method: 'POST', url: '/api/organizations/1/people', headers: { cookie: cookie.jordan! },
      payload: { name: 'Authz Cross Org', title: 'T', team: 'X', managerId: other },
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});
