import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Mandatory email verification and self-service password reset, through the real app and
 * schema. Emails land in resendEmail.ts's in-memory outbox (EMAIL_TRANSPORT=memory), so each
 * test follows the actual link a person would click.
 */

let app: FastifyInstance;
let pool: Pool;
let outbox: { to: string; subject: string; text: string }[];
let ip = 0;
const stamp = Date.now();
const mail = (who: string) => `${who}-${stamp}@example.test`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function waitForLink(to: string, kind: 'verify-email' | 'reset-password', after: number): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    const hit = outbox.slice(after).reverse().find((m) => m.to === to && m.text.includes(`/${kind}/`));
    if (hit) return hit.text.match(new RegExp(`/${kind}/(ao[vr]_[A-Za-z0-9_-]{43})`))![1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${kind} email to ${to}`);
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === 'aom_session');
  return c ? `aom_session=${c.value}` : '';
};

async function signup(who: string, password = `${who}-password-1`) {
  const email = mail(who);
  const before = outbox.length;
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', remoteAddress: `10.9.0.${++ip}`, payload: { name: who, email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return { email, password, cookie: cookieOf(res), body: res.json(), outboxBefore: before };
}

const me = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.9.1.${++ip}`, payload: { email, password } });
const requestReset = (email: string) =>
  app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: `10.9.2.${++ip}`, payload: { email } });
const confirmReset = (token: string, newPassword: string) =>
  app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', remoteAddress: `10.9.3.${++ip}`, payload: { token, newPassword } });
const verify = (token: string) =>
  app.inject({ method: 'POST', url: '/api/auth/verify-email', remoteAddress: `10.9.4.${++ip}`, payload: { token } });

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  ({ outbox } = await import('./integrations/resendEmail.js'));
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('email verification is required after signup', () => {
  it('a new signup is emailed a link and can do nothing else until it uses it', async () => {
    const s = await signup('verify-me');
    expect(s.body.verificationEmailSent).toBe(true);
    expect(s.body.account.emailVerificationPending).toBe(true);
    const token = await waitForLink(s.email, 'verify-email', s.outboxBefore);

    const blocked = await app.inject({ method: 'GET', url: `/api/org?orgId=${s.body.organization.id}`, headers: { cookie: s.cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('email_unverified');
    for (const url of ['/api/accounts/me/connectors', `/api/organizations/${s.body.organization.id}/admins`]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: s.cookie } })).json().code).toBe('email_unverified');
    }
    expect((await me(s.cookie)).account.emailVerificationPending).toBe(true);

    // The link works without the session (it may be opened on another device).
    expect((await verify(token)).statusCode).toBe(200);
    const after = await me(s.cookie);
    expect(after.account).toMatchObject({ emailVerified: true, emailVerificationPending: false });
    expect((await app.inject({ method: 'GET', url: `/api/org?orgId=${s.body.organization.id}`, headers: { cookie: s.cookie } })).statusCode).toBe(200);

    expect((await verify(token)).statusCode).toBe(410);
  });

  it('resending retires the earlier link', async () => {
    const s = await signup('resend-me');
    const first = await waitForLink(s.email, 'verify-email', s.outboxBefore);
    const before = outbox.length;
    const resend = await app.inject({ method: 'POST', url: '/api/auth/verify-email/resend', headers: { cookie: s.cookie } });
    expect(resend.json()).toEqual({ sent: true });
    const second = await waitForLink(s.email, 'verify-email', before);
    expect(second).not.toBe(first);
    expect((await verify(first)).statusCode).toBe(410);
    expect((await verify(second)).statusCode).toBe(200);
  });

  it('an expired link is refused', async () => {
    const s = await signup('too-late');
    const token = await waitForLink(s.email, 'verify-email', s.outboxBefore);
    await pool.query("UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [sha256(token)]);
    expect((await verify(token)).statusCode).toBe(410);
    expect((await me(s.cookie)).account.emailVerificationPending).toBe(true);
  });

  it('a made-up or malformed link gets nothing', async () => {
    expect((await verify(`aov_${'A'.repeat(43)}`)).statusCode).toBe(404);
    expect((await verify('not-a-token')).statusCode).toBe(400);
  });

  it('accounts from before verification existed are not locked out', async () => {
    const res = await login('diego@agentorgmesh.local', 'admin-dev-only');
    expect(res.statusCode).toBe(200);
    const ok = await app.inject({ method: 'GET', url: '/api/person/11/connectors', headers: { cookie: cookieOf(res) } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('self-service password reset', () => {
  it('answers identically for a real and an unknown address, and only emails the real one', async () => {
    const s = await signup('reset-real');
    const before = outbox.length;
    const known = await requestReset(s.email);
    const unknown = await requestReset(mail('nobody-here'));
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    await waitForLink(s.email, 'reset-password', before);
    await new Promise((r) => setTimeout(r, 200));
    expect(outbox.slice(before).some((m) => m.to === mail('nobody-here'))).toBe(false);
  });

  it('sets the new password, kills every session, and verifies the email — once', async () => {
    const s = await signup('reset-flow');
    const second = cookieOf(await login(s.email, s.password));
    const before = outbox.length;
    await requestReset(s.email);
    const token = await waitForLink(s.email, 'reset-password', before);

    expect((await confirmReset(token, 'short')).statusCode).toBe(400);
    expect((await confirmReset(token, 'a-brand-new-password')).statusCode, 'reset').toBe(200);

    expect((await me(s.cookie)).account).toBeNull();
    expect((await me(second)).account).toBeNull();
    expect((await login(s.email, s.password)).statusCode).toBe(401);
    const fresh = await login(s.email, 'a-brand-new-password');
    expect(fresh.statusCode).toBe(200);
    expect((await me(cookieOf(fresh))).account).toMatchObject({ emailVerified: true, emailVerificationPending: false });

    expect((await confirmReset(token, 'another-new-password')).statusCode).toBe(410);
  });

  it('only the newest reset link works, and an expired one is refused', async () => {
    const s = await signup('reset-twice');
    let before = outbox.length;
    await requestReset(s.email);
    const older = await waitForLink(s.email, 'reset-password', before);
    before = outbox.length;
    await requestReset(s.email);
    const newer = await waitForLink(s.email, 'reset-password', before);
    expect((await confirmReset(older, 'password-from-old-link')).statusCode).toBe(410);

    await pool.query("UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [sha256(newer)]);
    expect((await confirmReset(newer, 'password-from-expired-link')).statusCode).toBe(410);
    expect((await confirmReset(`aor_${'A'.repeat(43)}`, 'whatever-password')).statusCode).toBe(404);
  });

  it('stops emailing one address after three requests an hour, without changing the answer', async () => {
    const s = await signup('reset-flood');
    const before = outbox.length;
    for (let i = 0; i < 5; i += 1) expect((await requestReset(s.email)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(outbox.slice(before).filter((m) => m.to === s.email && m.text.includes('/reset-password/')).length).toBe(3);
  });
});

describe('a squatter can no longer block a real employee’s invitation', () => {
  it('the real owner resets the password, the squatter is signed out, and the invitation is accepted', async () => {
    const victimEmail = mail('real-cfo');

    // An attacker registers the future employee's address first and never verifies it.
    const squatterPassword = 'squatter-password-1';
    const squat = await app.inject({
      method: 'POST', url: '/api/auth/signup', remoteAddress: `10.9.5.${++ip}`,
      payload: { name: 'Squatter', email: victimEmail, password: squatterPassword },
    });
    expect(squat.statusCode).toBe(200);
    const squatterCookie = cookieOf(squat);

    // A verified owner adds the real person; the invitation goes to the real inbox.
    const owner = await signup('cfo-hiring-owner');
    await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [owner.email]);
    const added = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.body.organization.id}/people`, headers: { cookie: owner.cookie },
      payload: { name: 'Real CFO', title: 'CFO', team: 'Finance', managerId: null, agentDeployed: true, email: victimEmail },
    });
    expect(added.statusCode, added.body).toBe(200);
    const inviteToken = added.json().invite.url.split('/invite/')[1];
    expect(added.json().invite.emailSent).toBe(true);

    // The real person can't sign up (the address is taken)...
    const blockedSignup = await app.inject({
      method: 'POST', url: '/api/auth/signup', remoteAddress: `10.9.5.${++ip}`,
      payload: { name: 'Real CFO', email: victimEmail, password: 'real-cfo-password-1' },
    });
    expect(blockedSignup.statusCode).toBe(409);
    expect(blockedSignup.json().error).toMatch(/reset/i);

    // ...so they reset the password from their own inbox.
    const before = outbox.length;
    await requestReset(victimEmail);
    const resetToken = await waitForLink(victimEmail, 'reset-password', before);
    expect((await confirmReset(resetToken, 'real-cfo-password-1')).statusCode).toBe(200);

    expect((await me(squatterCookie)).account).toBeNull();
    expect((await login(victimEmail, squatterPassword)).statusCode).toBe(401);

    const real = await login(victimEmail, 'real-cfo-password-1');
    expect(real.statusCode).toBe(200);
    const accepted = await app.inject({ method: 'POST', url: `/api/invitations/${inviteToken}/accept`, headers: { cookie: cookieOf(real) } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const linked = (await pool.query('SELECT p.account_id, a.email FROM people p JOIN accounts a ON a.id = p.account_id WHERE p.org_id = $1 AND p.name = $2', [owner.body.organization.id, 'Real CFO'])).rows[0];
    expect(linked.email).toBe(victimEmail);
  });

  it('an unverified account cannot accept an invitation that was only shared by hand', async () => {
    const owner = await signup('manual-share-owner');
    await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [owner.email]);
    const inviteeEmail = mail('manual-invitee');
    const added = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.body.organization.id}/people`, headers: { cookie: owner.cookie },
      payload: { name: 'Manual Invitee', title: 'Analyst', team: 'Ops', managerId: null, agentDeployed: true, email: inviteeEmail },
    });
    const { id, url } = added.json().invite;
    await pool.query('UPDATE invitations SET emailed_at = NULL WHERE id = $1', [id]);

    const invitee = await signup('manual-invitee');
    const token = url.split('/invite/')[1];
    const refused = await app.inject({ method: 'POST', url: `/api/invitations/${token}/accept`, headers: { cookie: invitee.cookie } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/verify/i);

    const verifyToken = await waitForLink(invitee.email, 'verify-email', invitee.outboxBefore);
    expect((await verify(verifyToken)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/invitations/${token}/accept`, headers: { cookie: invitee.cookie } })).statusCode).toBe(200);
  });
});
