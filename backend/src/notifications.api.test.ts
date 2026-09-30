import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * "Someone asked about you" notifications (the top-bar bell). Seed, org 1 "Northbeam":
 * diego = person 11 (the subject), marta = person 1 (CEO, a real Executive for Diego),
 * jordan = owner-admin of org 1 with no chart identity.
 */

interface Item { id: string; askedAt: string; askerName: string; askerRole: string; question: string; personId: number; orgId: number; orgName: string; unread: boolean }
interface Feed { items: Item[]; unreadCount: number }

let app: FastifyInstance;
let pool: Pool;
const cookie: Record<'diego' | 'marta' | 'jordan' | 'outsider', string> = { diego: '', marta: '', jordan: '', outsider: '' };
const MARK = `notif-test-${Date.now()}`;

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-dev-only' } });
  expect(res.statusCode, res.body).toBe(200);
  return sessionCookie(res);
}

const feed = async (who: keyof typeof cookie): Promise<Feed> => {
  const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: cookie[who] } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};

const seen = (who: keyof typeof cookie, through: string) =>
  app.inject({ method: 'POST', url: '/api/notifications/seen', headers: { cookie: cookie[who] }, payload: { through } });

async function ask(who: 'marta' | 'diego', question: string, role = 'Executive') {
  const res = await app.inject({
    method: 'POST', url: '/api/agent/ask', headers: { cookie: cookie[who] },
    payload: { targetId: 11, role, question, persist: true },
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  cookie.diego = await login('diego@agentorgmesh.local');
  cookie.marta = await login('marta@agentorgmesh.local');
  cookie.jordan = await login('jordan@agentorgmesh.local');
  const email = `notif-outsider-${Date.now()}@example.test`;
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { name: 'Notif Outsider', email, password: 'outsider-pass-1' } });
  expect(signup.statusCode, signup.body).toBe(200);
  cookie.outsider = sessionCookie(signup);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  // Start Diego from a clean slate: everything asked before this test run counts as read.
  expect((await seen('diego', new Date().toISOString())).statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('someone asked about you', () => {
  it('needs a login', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/notifications' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/seen', payload: { through: new Date().toISOString() } })).statusCode).toBe(401);
  });

  it("an ask about Diego shows up in Diego's bell as unread, saying who asked and how", async () => {
    expect((await feed('diego')).unreadCount).toBe(0);
    await ask('marta', `${MARK} what is Diego working on?`);
    const { items, unreadCount } = await feed('diego');
    expect(unreadCount).toBe(1);
    const martaName = (await pool.query('SELECT name FROM people WHERE id = 1')).rows[0].name;
    expect(items[0]).toMatchObject({ askerName: martaName, askerRole: 'Executive', question: `${MARK} what is Diego working on?`, personId: 11, orgName: 'Northbeam', unread: true });
  });

  it('asking about yourself is not a notification', async () => {
    const before = await feed('diego');
    await ask('diego', `${MARK} what did I do?`, 'Self');
    const after = await feed('diego');
    expect(after.unreadCount).toBe(before.unreadCount);
    expect(after.items.some((i) => i.question.includes('what did I do?'))).toBe(false);
  });

  it("nobody else sees Diego's notifications", async () => {
    for (const who of ['marta', 'jordan', 'outsider'] as const) {
      const { items } = await feed(who);
      expect(items.some((i) => i.personId === 11), who).toBe(false);
    }
    expect((await feed('outsider')).items).toHaveLength(0);
  });

  it('marking read clears the count; it never moves backwards; a new ask counts again', async () => {
    const { items } = await feed('diego');
    expect((await seen('diego', items[0].askedAt)).statusCode).toBe(200);
    const cleared = await feed('diego');
    expect(cleared.unreadCount).toBe(0);
    expect(cleared.items[0].unread).toBe(false);

    await seen('diego', '2020-01-01T00:00:00.000Z');
    expect((await feed('diego')).unreadCount).toBe(0);

    await ask('marta', `${MARK} and now?`);
    expect((await feed('diego')).unreadCount).toBe(1);
  });

  it('a future "read through" date is capped at now, so later asks still count as unread', async () => {
    await seen('diego', '2999-01-01T00:00:00.000Z');
    expect((await feed('diego')).unreadCount).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    await ask('marta', `${MARK} after a future mark`);
    expect((await feed('diego')).unreadCount).toBe(1);
  });

  it('rejects a malformed date', async () => {
    expect((await seen('diego', 'yesterday')).statusCode).toBe(400);
  });
});

/**
 * The bell reads audit_log directly instead of going through getPeopleForAccount, so it has to
 * restate that function's filters or it reports on access the person no longer has. Found by
 * probing (2026-09-30): after being removed from a chart, or after the organization was deleted,
 * the badge still showed items — and opening one returned 403.
 */
describe('the bell only shows organizations you can still open', () => {
  let ip = 0;

  async function newAccount(label: string) {
    const email = `notif-scope-${label}-${Date.now()}-${++ip}@example.test`;
    const res = await app.inject({
      method: 'POST', url: '/api/auth/signup', remoteAddress: `10.81.${ip % 250}.${(ip % 250) + 1}`,
      payload: { name: `Scope ${label}`, email, password: 'notif-scope-pass-1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
    const own = sessionCookie(res);
    const step = await app.inject({
      method: 'POST', url: '/api/auth/step-up', headers: { cookie: own }, payload: { password: 'notif-scope-pass-1' },
    });
    expect(step.statusCode, step.body).toBe(200);
    return { cookie: own, orgId: res.json().organization.id as number, personId: res.json().person.id as number, accountId: res.json().account.id as number };
  }

  /** An owner, plus a real employee account linked to a chart entry under them, already asked about. */
  async function orgWithSubject(label: string, subjectAccountId: number, subjectCookie: string) {
    const owner = await newAccount(`${label}-owner`);
    const added = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/people`, headers: { cookie: owner.cookie },
      payload: { name: 'Subject', title: 'Engineer', team: 'Eng', managerId: owner.personId, agentDeployed: true },
    });
    expect(added.statusCode, added.body).toBe(200);
    const personId = added.json().person.id as number;
    await pool.query('UPDATE people SET account_id = $1 WHERE id = $2', [subjectAccountId, personId]);
    const asked = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: owner.cookie },
      payload: { targetId: personId, role: 'Direct manager', question: 'What are you working on?', persist: true },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: subjectCookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as Feed).items.some((i) => i.personId === personId), 'the subject should see it while they are still in the chart').toBe(true);
    return { owner, personId };
  }

  const feedFor = async (own: string): Promise<Feed> => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: own } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  it('drops items once the subject is removed from that chart, badge included', async () => {
    const subject = await newAccount('removed-subject');
    const { owner, personId } = await orgWithSubject('removed', subject.accountId, subject.cookie);
    const before = await feedFor(subject.cookie);
    expect(before.unreadCount).toBeGreaterThan(0);

    const removed = await app.inject({
      method: 'DELETE', url: `/api/organizations/${owner.orgId}/people/${personId}`, headers: { cookie: owner.cookie },
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const after = await feedFor(subject.cookie);
    expect(after.items.some((i) => i.personId === personId)).toBe(false);
    expect(after.unreadCount, 'the badge must not outlive the items').toBe(0);

    // The reason it must not be listed: opening it is refused.
    const who = await app.inject({
      method: 'GET', url: `/api/audit/subject/${personId}`, headers: { cookie: subject.cookie },
    });
    expect(who.statusCode).toBe(403);
  });

  it('drops items once that organization is deleted', async () => {
    const subject = await newAccount('archived-subject');
    const { owner, personId } = await orgWithSubject('archived', subject.accountId, subject.cookie);

    // Archiving needs an empty chart, so the subject leaves first; the organization is then gone
    // for everyone, which is the state under test.
    await app.inject({ method: 'DELETE', url: `/api/organizations/${owner.orgId}/people/${personId}`, headers: { cookie: owner.cookie } });
    const archived = await app.inject({ method: 'DELETE', url: `/api/organizations/${owner.orgId}`, headers: { cookie: owner.cookie } });
    expect(archived.statusCode, archived.body).toBe(200);

    const after = await feedFor(subject.cookie);
    expect(after.items.some((i) => i.orgId === owner.orgId)).toBe(false);
    expect(after.unreadCount).toBe(0);
  });

  // The archived-organization filter needs a subject who is NOT removed, or the removal filter
  // alone already hides the row and this proves nothing (the first version of this test made
  // exactly that mistake — both archiving mutations passed). Archiving requires an empty chart
  // except the owner, so the owner has to be the subject: an IT-team colleague asks about them
  // truthfully, that colleague leaves, and the organization is then deleted.
  it('drops items for a deleted organization even when the subject is still in its chart', async () => {
    const owner = await newAccount('still-charted-owner');
    const asker = await newAccount('still-charted-asker');
    const added = await app.inject({
      method: 'POST', url: `/api/organizations/${owner.orgId}/people`, headers: { cookie: owner.cookie },
      payload: { name: 'IT Colleague', title: 'IT', team: 'IT', managerId: owner.personId, agentDeployed: true },
    });
    expect(added.statusCode, added.body).toBe(200);
    const askerPersonId = added.json().person.id as number;
    await pool.query('UPDATE people SET account_id = $1 WHERE id = $2', [asker.accountId, askerPersonId]);

    const asked = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: asker.cookie },
      payload: { targetId: owner.personId, role: 'IT admin', question: 'Anything blocked?', persist: true },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    expect((await feedFor(owner.cookie)).items.some((i) => i.personId === owner.personId)).toBe(true);

    await app.inject({
      method: 'DELETE', url: `/api/organizations/${owner.orgId}/people/${askerPersonId}`, headers: { cookie: owner.cookie },
    });
    const archived = await app.inject({ method: 'DELETE', url: `/api/organizations/${owner.orgId}`, headers: { cookie: owner.cookie } });
    expect(archived.statusCode, archived.body).toBe(200);

    // The owner's own chart entry is untouched — only the organization is gone — so this row is
    // hidden by the archived-organization filter alone.
    const row = await pool.query('SELECT removed_at FROM people WHERE id = $1', [owner.personId]);
    expect(row.rows[0].removed_at, 'the subject must still be in the chart for this test to bite').toBeNull();

    const after = await feedFor(owner.cookie);
    expect(after.items.some((i) => i.orgId === owner.orgId)).toBe(false);
    expect(after.unreadCount).toBe(0);
  });

  it('keeps items for the organizations they are still in', async () => {
    const subject = await newAccount('two-orgs-subject');
    const leaving = await orgWithSubject('leaving', subject.accountId, subject.cookie);
    const staying = await orgWithSubject('staying', subject.accountId, subject.cookie);

    await app.inject({
      method: 'DELETE', url: `/api/organizations/${leaving.owner.orgId}/people/${leaving.personId}`,
      headers: { cookie: leaving.owner.cookie },
    });

    const after = await feedFor(subject.cookie);
    expect(after.items.some((i) => i.personId === leaving.personId), 'the org they left').toBe(false);
    expect(after.items.some((i) => i.personId === staying.personId), 'the org they are still in').toBe(true);
    expect(after.unreadCount, 'still one live item to read').toBe(1);
  });
});
