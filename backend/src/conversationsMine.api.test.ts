import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Ask page chat list: GET /api/agent/conversations/mine?orgId= returns every chat the
 * signed-in person has had about other people, labelled by who it's about.
 * Seed, org 1: marta = person 1 (CEO, Executive for everyone), diego = person 11, person 12 (Amara).
 */

interface Conv { id: string; title: string; turnCount: number; targetId: number; targetName: string; targetTitle: string }

let app: FastifyInstance;
let pool: Pool;
const cookie: Record<string, string> = {};
const MARK = `mine-${Date.now()}`;

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `aom_session=${res.cookies.find((c) => c.name === 'aom_session')!.value}`;
const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-dev-only' } });
  expect(res.statusCode, res.body).toBe(200);
  return sessionCookie(res);
};
const ask = async (who: string, targetId: number, role: string, question: string, conversationId?: string) => {
  const res = await app.inject({
    method: 'POST', url: '/api/agent/ask', headers: { cookie: cookie[who] },
    payload: { targetId, role, question, persist: true, ...(conversationId ? { conversationId } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().conversationId as string;
};
const mine = async (who: string, orgId = 1) => app.inject({ method: 'GET', url: `/api/agent/conversations/mine?orgId=${orgId}`, headers: cookie[who] ? { cookie: cookie[who] } : {} });

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  cookie.marta = await login('marta@agentorgmesh.local');
  cookie.diego = await login('diego@agentorgmesh.local');
  const email = `mine-outsider-${Date.now()}@example.test`;
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', remoteAddress: '10.9.8.1', payload: { name: 'Outsider', email, password: 'outsider-pass-1' } });
  expect(signup.statusCode, signup.body).toBe(200);
  await pool.query('UPDATE accounts SET email_verified_at = now() WHERE email = $1', [email]);
  cookie.outsider = sessionCookie(signup);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('your chats, labelled by who they are with', () => {
  it('lists chats with different people, each named, newest first, with turns counted', async () => {
    const withDiego = await ask('marta', 11, 'Executive', `${MARK} what is Diego working on?`);
    await ask('marta', 11, 'Executive', `${MARK} and anything blocked?`, withDiego);
    const withAmara = await ask('marta', 12, 'Executive', `${MARK} what is Amara working on?`);

    const res = await mine('marta');
    expect(res.statusCode, res.body).toBe(200);
    const convs = (res.json().conversations as Conv[]).filter((c) => c.title.startsWith(MARK));
    expect(convs.map((c) => c.id)).toEqual([withAmara, withDiego]);
    const diegoName = (await pool.query('SELECT name, title FROM people WHERE id = 11')).rows[0];
    expect(convs[1]).toMatchObject({ targetId: 11, targetName: diegoName.name, targetTitle: diegoName.title, turnCount: 2 });
    expect(convs[0].targetId).toBe(12);
  });

  it("doesn't include asking about yourself — that chat lives on My agent", async () => {
    await ask('marta', 1, 'Self', `${MARK} what have I been working on?`);
    const convs = (await mine('marta')).json().conversations as Conv[];
    expect(convs.some((c) => c.targetId === 1)).toBe(false);
  });

  it("never shows someone else's chats", async () => {
    const res = await mine('diego');
    expect(res.statusCode).toBe(200);
    expect((res.json().conversations as Conv[]).some((c) => c.title.startsWith(MARK))).toBe(false);
  });

  it('refuses signed-out callers and people outside the organization', async () => {
    expect((await mine('nobody')).statusCode).toBe(401);
    expect((await mine('outsider')).statusCode).toBe(403);
  });
});
