import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * "Remove from my list" on Ask chats (DELETE /api/agent/conversations/:id?orgId=).
 * Asks are append-only audit rows (rule 2) that the person asked about sees in "Who asked
 * about me", so removing a chat must hide it from the asker's lists and change nothing else.
 * Seed, org 1: marta = person 1 (CEO), diego = person 11.
 */

let app: FastifyInstance;
let pool: Pool;
const cookie: Record<string, string> = {};
const MARK = `hide-${Date.now()}`;

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;
const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-dev-only' } });
  expect(res.statusCode, res.body).toBe(200);
  return sessionCookie(res);
};
const hide = (who: string | null, id: string) =>
  app.inject({ method: 'DELETE', url: `/api/agent/conversations/${id}?orgId=1`, headers: who ? { cookie: cookie[who] } : {} });
const myList = async (who: string) =>
  ((await app.inject({ method: 'GET', url: '/api/agent/conversations/mine?orgId=1', headers: { cookie: cookie[who] } })).json().conversations as { id: string }[]);

let chatId = '';

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  cookie.marta = await login('marta@agentorgmesh.local');
  cookie.diego = await login('diego@agentorgmesh.local');
  const asked = await app.inject({
    method: 'POST', url: '/api/agent/ask', headers: { cookie: cookie.marta },
    payload: { targetId: 11, role: 'Executive', question: `${MARK} what is Diego working on?`, persist: true },
  });
  expect(asked.statusCode, asked.body).toBe(200);
  chatId = asked.json().conversationId;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('remove a chat from your list', () => {
  it("refuses signed-out callers, and nobody can remove someone else's chat", async () => {
    expect((await hide(null, chatId)).statusCode).toBe(401);
    expect((await hide('diego', chatId)).statusCode).toBe(404);
    expect((await myList('marta')).some((c) => c.id === chatId)).toBe(true);
  });

  it('hides it from both of your lists, and leaves the permanent record untouched', async () => {
    const auditBefore = Number((await pool.query('SELECT count(*) FROM audit_log WHERE conversation_id = $1', [chatId])).rows[0].count);
    expect(auditBefore).toBe(1);

    expect((await hide('marta', chatId)).statusCode).toBe(200);

    expect((await myList('marta')).some((c) => c.id === chatId)).toBe(false);
    const pair = await app.inject({ method: 'GET', url: '/api/agent/conversations?targetId=11', headers: { cookie: cookie.marta } });
    expect((pair.json().conversations as { id: string }[]).some((c) => c.id === chatId)).toBe(false);

    const auditAfter = Number((await pool.query('SELECT count(*) FROM audit_log WHERE conversation_id = $1', [chatId])).rows[0].count);
    expect(auditAfter).toBe(auditBefore);
    const whoAsked = await app.inject({ method: 'GET', url: '/api/audit/subject/11', headers: { cookie: cookie.diego } });
    expect((whoAsked.json().entries as { question: string }[]).some((e) => e.question.startsWith(MARK))).toBe(true);
  });

  it('is safe to repeat, and a chat that never existed is a 404', async () => {
    expect((await hide('marta', chatId)).statusCode).toBe(200);
    expect((await hide('marta', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('a new question about the same person starts a fresh chat that shows up again', async () => {
    const asked = await app.inject({
      method: 'POST', url: '/api/agent/ask', headers: { cookie: cookie.marta },
      payload: { targetId: 11, role: 'Executive', question: `${MARK} anything blocked?`, persist: true },
    });
    const fresh = asked.json().conversationId as string;
    expect(fresh).not.toBe(chatId);
    expect((await myList('marta')).some((c) => c.id === fresh)).toBe(true);
  });
});
