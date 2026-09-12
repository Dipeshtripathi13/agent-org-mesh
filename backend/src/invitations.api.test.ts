import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Release audit SEC-08 against the real app and schema. The attack: sign up early with a
 * future employee's email, wait for an admin to add that email, and become that employee.
 * An email now only ever creates an invitation, bound when an account with that exact email
 * presents the one-time link.
 *
 * Every actor is a fresh signup (its own one-person org, elevated at signup), so this never
 * touches the seeded Northbeam org or its seat limit.
 */

let app: FastifyInstance;
let pool: Pool;
let ip = 0;
const stamp = Date.now();
const mail = (who: string) => `${who}-${stamp}@example.test`;

interface Actor { cookie: string; accountId: number; orgId: number; email: string }

/** Signups are verified by default here — email.api.test.ts covers the verification gate.
 *  Pass `verified: false` for an account that has only claimed its address. */
async function signup(who: string, { verified = true }: { verified?: boolean } = {}): Promise<Actor> {
  const email = mail(who);
  const res = await app.inject({
    method: 'POST', url: '/api/auth/signup', remoteAddress: `10.8.0.${++ip}`,
    payload: { name: who, email, password: `${who}-password-1` },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  if (verified) await pool.query('UPDATE accounts SET email_verified_at = now() WHERE id = $1', [body.account.id]);
  const session = res.cookies.find((c) => c.name === 'aom_session')!;
  return { cookie: `aom_session=${session.value}`, accountId: body.account.id, orgId: body.organization.id, email };
}

const as = (actor: Actor | null) => (actor ? { cookie: actor.cookie } : {});
const tokenOf = (url: string) => url.split('/invite/')[1];

async function addPerson(owner: Actor, email: string | undefined, name = 'Invited Person') {
  const res = await app.inject({
    method: 'POST', url: `/api/organizations/${owner.orgId}/people`, headers: as(owner),
    payload: { name, title: 'Chief Financial Officer', team: 'Finance', managerId: null, agentDeployed: true, ...(email ? { email } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { person: { id: number; accountId: number | null }; invite: { url: string; id: string; emailSent: boolean } | null };
}

const accept = (token: string, actor: Actor | null) =>
  app.inject({ method: 'POST', url: `/api/invitations/${token}/accept`, headers: as(actor) });

let owner: Actor;

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  owner = await signup('owner');
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('pre-registering a future employee’s email no longer captures their identity', () => {
  it('adding a person whose email already has an account links nothing and returns a link instead', async () => {
    const squatter = await signup('future-cfo', { verified: false });
    const { person, invite } = await addPerson(owner, squatter.email);

    expect(invite?.url).toMatch(/\/invite\/aoi_[A-Za-z0-9_-]{43}$/);
    expect(invite?.emailSent).toBe(true);
    expect(person.accountId).toBeNull();
    const row = (await pool.query('SELECT account_id FROM people WHERE id = $1', [person.id])).rows[0];
    expect(row.account_id).toBeNull();

    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(squatter) })).json();
    expect(me.people.some((p: { orgId: number }) => p.orgId === owner.orgId)).toBe(false);
    const roster = await app.inject({ method: 'GET', url: `/api/org?orgId=${owner.orgId}`, headers: as(squatter) });
    expect(roster.statusCode).toBe(403);
  });

  it('no temporary password is issued any more', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/people`, headers: as(owner),
      payload: { name: 'No Temp', title: 'Analyst', team: 'Finance', managerId: null, agentDeployed: true, email: mail('no-temp') },
    });
    expect(res.json()).not.toHaveProperty('tempPassword');
    expect((await pool.query('SELECT count(*)::int AS n FROM accounts WHERE email = $1', [mail('no-temp')])).rows[0].n).toBe(0);
  });
});

describe('accepting an invitation', () => {
  it('binds exactly that chart entry for the matching account, once', async () => {
    const { person, invite } = await addPerson(owner, mail('new-hire'), 'New Hire');
    const token = tokenOf(invite!.url);

    const lookup = await app.inject({ method: 'GET', url: `/api/invitations/${token}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().invitation).toMatchObject({ status: 'pending', kind: 'person', email: mail('new-hire'), personName: 'New Hire' });

    expect((await accept(token, null)).statusCode).toBe(401);

    const wrongAccount = await accept(token, owner);
    expect(wrongAccount.statusCode).toBe(403);
    expect(wrongAccount.json().error).toContain(mail('new-hire'));

    const newHire = await signup('new-hire', { verified: false });
    const ok = await accept(token, newHire);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await pool.query('SELECT account_id FROM people WHERE id = $1', [person.id])).rows[0].account_id).toBe(newHire.accountId);

    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(newHire) })).json();
    expect(me.people.some((p: { id: number }) => p.id === person.id)).toBe(true);
    expect(me.account.emailVerified).toBe(true); // accepting an emailed invitation proves the inbox
    expect(me.account.emailVerificationPending).toBe(false);

    expect((await accept(token, newHire)).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${token}` })).json().invitation.status).toBe('accepted');

    // As a member (not an admin) they can't see or create invitations.
    expect((await app.inject({ method: 'GET', url: `/api/organizations/${owner.orgId}/invitations`, headers: as(newHire) })).statusCode).toBe(403);
  });

  it('a second invitation for someone who already has a place in the chart is refused', async () => {
    const twice = await signup('twice');
    const first = await addPerson(owner, twice.email, 'Twice One');
    expect((await accept(tokenOf(first.invite!.url), twice)).statusCode).toBe(200);
    const second = await addPerson(owner, twice.email, 'Twice Two');
    expect((await accept(tokenOf(second.invite!.url), twice)).statusCode).toBe(409);
  });

  it('an expired invitation is refused', async () => {
    const { invite } = await addPerson(owner, mail('late'));
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [invite!.id]);
    const late = await signup('late');
    expect((await accept(tokenOf(invite!.url), late)).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${tokenOf(invite!.url)}` })).json().invitation.status).toBe('expired');
  });

  it('a revoked invitation is refused and leaves the pending list', async () => {
    const { invite } = await addPerson(owner, mail('revoked'));
    const listed = await app.inject({ method: 'GET', url: `/api/organizations/${owner.orgId}/invitations`, headers: as(owner) });
    expect(listed.json().invitations.some((i: { id: string }) => i.id === invite!.id)).toBe(true);

    const revoke = await app.inject({ method: 'DELETE', url: `/api/organizations/${owner.orgId}/invitations/${invite!.id}`, headers: as(owner) });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const revoked = await signup('revoked');
    expect((await accept(tokenOf(invite!.url), revoked)).statusCode).toBe(410);
    const after = await app.inject({ method: 'GET', url: `/api/organizations/${owner.orgId}/invitations`, headers: as(owner) });
    expect(after.json().invitations.some((i: { id: string }) => i.id === invite!.id)).toBe(false);
  });

  it('removing the person cancels their invitation', async () => {
    const { person, invite } = await addPerson(owner, mail('removed'));
    const del = await app.inject({ method: 'DELETE', url: `/api/organizations/${owner.orgId}/people/${person.id}`, headers: as(owner) });
    expect(del.statusCode, del.body).toBe(200);
    const removed = await signup('removed');
    expect((await accept(tokenOf(invite!.url), removed)).statusCode).toBe(404);
  });

  it('a made-up or malformed token gets nothing', async () => {
    const fake = `aoi_${'A'.repeat(43)}`;
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${fake}` })).statusCode).toBe(404);
    expect((await accept(fake, owner)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/invitations/not-a-token' })).statusCode).toBe(400);
  });
});

describe('admin invitations', () => {
  it('grant the role only on acceptance, and only to the matching account', async () => {
    const adminEmail = mail('new-admin');
    const res = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/admins`, headers: as(owner),
      payload: { email: adminEmail, name: 'New Admin', role: 'viewer' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).not.toHaveProperty('tempPassword');
    const token = tokenOf(res.json().invite.url);

    const admins = async () =>
      (await app.inject({ method: 'GET', url: `/api/organizations/${owner.orgId}/admins`, headers: as(owner) })).json().admins as { email: string; role: string }[];
    expect((await admins()).some((a) => a.email === adminEmail)).toBe(false);

    const outsider = await signup('not-the-admin');
    expect((await accept(token, outsider)).statusCode).toBe(403);
    expect((await admins()).some((a) => a.email === outsider.email)).toBe(false);

    const newAdmin = await signup('new-admin');
    expect((await accept(token, newAdmin)).statusCode).toBe(200);
    expect((await admins()).find((a) => a.email === adminEmail)?.role).toBe('viewer');
  });

  it('accepting a lesser admin invitation never downgrades an existing role', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/admins`, headers: as(owner),
      payload: { email: owner.email, role: 'viewer' },
    });
    expect((await accept(tokenOf(res.json().invite.url), owner)).statusCode).toBe(200);
    const role = (await pool.query('SELECT role FROM org_admins WHERE org_id = $1 AND account_id = $2', [owner.orgId, owner.accountId])).rows[0].role;
    expect(role).toBe('owner');
  });

  it('non-owners cannot issue or revoke admin invitations', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/admins`, headers: as(owner),
      payload: { email: mail('pending-admin'), role: 'admin' },
    });
    const newAdmin = await signup('member-admin');
    const promote = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/admins`, headers: as(owner),
      payload: { email: newAdmin.email, role: 'admin' },
    });
    expect((await accept(tokenOf(promote.json().invite.url), newAdmin)).statusCode).toBe(200);

    const issue = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/admins`, headers: as(newAdmin),
      payload: { email: mail('escalate'), role: 'owner' },
    });
    expect(issue.statusCode).toBe(403);
    const revoke = await app.inject({
      method: 'DELETE', url: `/api/organizations/${owner.orgId}/invitations/${res.json().invite.id}`, headers: as(newAdmin),
    });
    expect([403, 428]).toContain(revoke.statusCode);
  });
});
