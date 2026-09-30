import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ORGS_PER_ACCOUNT } from './plans.js';

/**
 * Deleting an organization archives it (migration 0008). The 402 from the
 * organizations-per-account cap tells people to remove one they no longer need, so there has
 * to be a way to actually do that — and it has to free the slot.
 */

let app: FastifyInstance;
let pool: Pool;
let ip = 0;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;

async function newOwner(label: string) {
  const email = `orgdel-${label}-${Date.now()}-${++ip}@example.test`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', remoteAddress: `10.40.${ip % 250}.${(ip % 250) + 1}`,
    payload: { name: `Owner ${label}`, email, password: 'org-deletion-pass-1' },
  });
  expect(res.statusCode, res.body).toBe(200);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  const cookie = cookieOf(res);
  // Same address as the signup above: step-up is rate limited per IP like login, so sharing one
  // default address across every account in the suite starts returning 429 as it grows.
  const step = await app.inject({
    method: 'POST', url: '/api/auth/step-up', headers: { cookie },
    remoteAddress: `10.40.${ip % 250}.${(ip % 250) + 1}`,
    payload: { password: 'org-deletion-pass-1' },
  });
  expect(step.statusCode, step.body).toBe(200);
  return { cookie, email, orgId: res.json().organization.id as number, accountId: res.json().account.id as number };
}

const createOrg = (cookie: string, name: string) =>
  app.inject({ method: 'POST', url: '/api/organizations', headers: { cookie }, payload: { name } });

const deleteOrg = (cookie: string, orgId: number) =>
  app.inject({ method: 'DELETE', url: `/api/organizations/${orgId}`, headers: { cookie } });

const listOrgIds = async (cookie: string) => {
  const res = await app.inject({ method: 'GET', url: '/api/organizations', headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().organizations as { id: number }[]).map((o) => o.id);
};

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('deleting an organization', () => {
  it('frees one of the account’s organization slots, which is what the cap tells people to do', async () => {
    const owner = await newOwner('cap'); // signup already made their first organization
    const created: number[] = [];
    for (let i = 2; i <= MAX_ORGS_PER_ACCOUNT; i += 1) {
      const res = await createOrg(owner.cookie, `Org ${i}`);
      expect(res.statusCode, res.body).toBe(200);
      created.push(res.json().organization.id);
    }
    const full = await createOrg(owner.cookie, 'One too many');
    expect(full.statusCode).toBe(402);
    expect(full.json().error).toMatch(/remove one you no longer need/i);

    expect((await deleteOrg(owner.cookie, created[0])).statusCode).toBe(200);

    const afterDelete = await createOrg(owner.cookie, 'Now there is room');
    expect(afterDelete.statusCode, afterDelete.body).toBe(200);
  });

  it('disappears from the account’s organizations, and every route on it closes', async () => {
    const owner = await newOwner('gone');
    const doomed = (await createOrg(owner.cookie, 'Doomed')).json().organization.id as number;
    expect(await listOrgIds(owner.cookie)).toContain(doomed);

    expect((await deleteOrg(owner.cookie, doomed)).statusCode).toBe(200);

    expect(await listOrgIds(owner.cookie)).not.toContain(doomed);
    for (const url of [`/api/org?orgId=${doomed}`, `/api/overview?orgId=${doomed}`, `/api/organizations/${doomed}/admins`]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      expect(res.statusCode, `${url} -> ${res.body}`).toBe(403);
    }
    // Their own chart identity in it is gone too, so they are no longer a member anywhere in it.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } });
    expect((me.json().people as { orgId: number }[]).some((p) => p.orgId === doomed)).toBe(false);
  });

  it('keeps what was asked — the organization is archived, never deleted', async () => {
    const owner = await newOwner('record');
    const doomed = (await createOrg(owner.cookie, 'Has History')).json().organization.id as number;
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } }))
      .json().people.find((p: { orgId: number }) => p.orgId === doomed).id as number;

    // A real ask, so the audit row under test is one the product actually wrote.
    const ask = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: owner.cookie },
      payload: { targetId: me, role: 'Self', question: 'What am I working on?', persist: true },
    });
    expect(ask.statusCode, ask.body).toBe(200);
    const before = await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1', [doomed]);
    expect(before.rows[0].n).toBeGreaterThan(0);

    expect((await deleteOrg(owner.cookie, doomed)).statusCode).toBe(200);

    const org = await pool.query('SELECT id FROM organizations WHERE id = $1', [doomed]);
    expect(org.rows.length, 'the organization row itself must survive').toBe(1);
    const archived = await pool.query('SELECT org_id FROM archived_organizations WHERE org_id = $1', [doomed]);
    expect(archived.rows.length).toBe(1);
    const after = await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1', [doomed]);
    expect(after.rows[0].n, 'asked questions are permanent (rule 2)').toBe(before.rows[0].n);
  });

  // Pushes and invitations don't pass through getOrgRole or an identity lookup, so archiving
  // has to close those two doors itself. Both were found open by probing after the fact: a
  // push kept returning 202, and an admin invitation still reported a successful join.
  it('stops accepting pushed activity', async () => {
    const owner = await newOwner('push');
    const orgId = (await createOrg(owner.cookie, 'Pushes Here')).json().organization.id as number;
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } }))
      .json().people.find((p: { orgId: number }) => p.orgId === orgId).id as number;
    const minted = await app.inject({
      method: 'POST', url: `/api/person/${me}/ingest-tokens`, headers: { cookie: owner.cookie },
      payload: { label: 'laptop' },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const token = minted.json().token as string;
    const push = () => app.inject({
      method: 'POST', url: '/api/ingest/claude-code', headers: { authorization: `Bearer ${token}` },
      payload: { events: [{ kind: 'tool_use', summary: 'Edited server.ts', occurredAt: new Date().toISOString() }] },
    });
    expect((await push()).statusCode).toBe(202);

    expect((await deleteOrg(owner.cookie, orgId)).statusCode).toBe(200);

    expect((await push()).statusCode).toBe(401);
  });

  it('kills invitations that were still outstanding', async () => {
    const owner = await newOwner('invite');
    const orgId = (await createOrg(owner.cookie, 'Invites Out')).json().organization.id as number;
    const inviteeEmail = `orgdel-invitee-${Date.now()}-${++ip}@example.test`;
    const invited = await app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/admins`, headers: { cookie: owner.cookie },
      payload: { email: inviteeEmail, name: 'Invitee', role: 'admin' },
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const token = (invited.json().invite.url as string).split('/invite/')[1];
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${token}` })).statusCode).toBe(200);

    expect((await deleteOrg(owner.cookie, orgId)).statusCode).toBe(200);

    // The link now reads as dead rather than showing a deleted organization...
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${token}` })).statusCode).toBe(404);

    // ...and accepting it says so, instead of reporting a join nobody can see.
    const signup = await app.inject({
      method: 'POST', url: '/api/auth/signup', remoteAddress: `10.41.${ip % 250}.${(ip % 250) + 1}`,
      payload: { name: 'Invitee', email: inviteeEmail, password: 'org-deletion-pass-2' },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [inviteeEmail]);
    const accept = await app.inject({
      method: 'POST', url: `/api/invitations/${token}/accept`, headers: { cookie: cookieOf(signup) },
    });
    expect(accept.statusCode).toBe(410);
    expect(accept.json().error).toMatch(/has been deleted/i);
    const granted = await pool.query(
      'SELECT 1 FROM org_admins WHERE org_id = $1 AND account_id = $2', [orgId, signup.json().account.id]);
    expect(granted.rows.length, 'no role may be written for a deleted organization').toBe(0);
  });

  it('refuses while anyone else is still in the chart', async () => {
    const owner = await newOwner('populated');
    const orgId = (await createOrg(owner.cookie, 'Still Populated')).json().organization.id as number;
    const person = await app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/people`, headers: { cookie: owner.cookie },
      payload: { name: 'Someone Else', title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true },
    });
    expect(person.statusCode, person.body).toBe(200);

    const refused = await deleteOrg(owner.cookie, orgId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/remove everyone else/i);

    await app.inject({
      method: 'DELETE', url: `/api/organizations/${orgId}/people/${person.json().person.id}`,
      headers: { cookie: owner.cookie },
    });
    expect((await deleteOrg(owner.cookie, orgId)).statusCode).toBe(200);
  });

  // A deleted organization has to stop counting everywhere, not just on the screens. The
  // admin password reset refuses anyone who also belongs to another organization (minting a
  // password there would hand this admin a login to someone else's org) — but an organization
  // that has been deleted grants nothing at all, so counting it only produced a refusal the
  // admin could neither understand nor clear.
  it('stops counting as "another organization" for an admin password reset', async () => {
    const employer = await newOwner('employer');
    const employee = await newOwner('employee'); // signup gave them their own workspace, which they own

    const added = await app.inject({
      method: 'POST', url: `/api/organizations/${employer.orgId}/people`, headers: { cookie: employer.cookie },
      payload: { name: 'Their Employee', title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true },
    });
    expect(added.statusCode, added.body).toBe(200);
    const personId = added.json().person.id as number;
    await pool.query('UPDATE people SET account_id = $1 WHERE id = $2', [employee.accountId, personId]);

    const reset = () => app.inject({
      method: 'POST', url: `/api/organizations/${employer.orgId}/people/${personId}/reset-password`,
      headers: { cookie: employer.cookie },
    });

    const refused = await reset();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatch(/another organization/i);

    // They delete their own workspace. It now grants nothing to anyone.
    expect((await deleteOrg(employee.cookie, employee.orgId)).statusCode).toBe(200);

    const allowed = await reset();
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().tempPassword).toBeTruthy();
  });

  it('is owner-only, and closed to outsiders', async () => {
    const owner = await newOwner('owner');
    const orgId = (await createOrg(owner.cookie, 'Mine')).json().organization.id as number;
    const outsider = await newOwner('outsider');

    expect((await deleteOrg(outsider.cookie, orgId)).statusCode).toBe(403);

    // An admin who is not the owner cannot either.
    await pool.query(
      `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,'admin',now())
       ON CONFLICT (org_id, account_id) DO UPDATE SET role = 'admin'`,
      [orgId, outsider.accountId],
    );
    const asAdmin = await deleteOrg(outsider.cookie, orgId);
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json().error).toMatch(/only an owner/i);

    expect((await deleteOrg(owner.cookie, orgId)).statusCode).toBe(200);
  });

  it('needs a fresh password confirmation, like every other write that cannot be undone', async () => {
    const owner = await newOwner('stepup');
    const orgId = (await createOrg(owner.cookie, 'Needs Step Up')).json().organization.id as number;
    await pool.query('UPDATE sessions SET elevated_until = now() - interval \'1 hour\' WHERE account_id = $1', [owner.accountId]);

    const res = await deleteOrg(owner.cookie, orgId);
    expect(res.statusCode).toBe(428);
    expect(await listOrgIds(owner.cookie)).toContain(orgId);
  });
});
