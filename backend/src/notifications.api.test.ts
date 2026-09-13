import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * "Someone asked about you" notifications (the top-bar bell). Seed, org 1 "Northbeam":
 * diego = person 11 (the subject), marta = person 1 (CEO, a real Executive for Diego),
 * jordan = owner-admin of org 1 with no chart identity.
 */

interface Item { id: string; askedAt: string; askerName: string; askerRole: string; question: string; personId: number; orgName: string; unread: boolean }
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
