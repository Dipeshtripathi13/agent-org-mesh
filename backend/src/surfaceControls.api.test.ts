import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Controls' pause/resume (POST /api/person/:id/surface/cycle). It used to cycle a tool from
 *  "not connected" to "connected" with no credential behind it. Diego = person 11. */

let app: FastifyInstance;
let pool: Pool;
let cookie = '';
const touched: { key: string; state: string }[] = [];

const press = (surfaceKey: string) =>
  app.inject({ method: 'POST', url: '/api/person/11/surface/cycle', headers: { cookie }, payload: { surfaceKey } });
const stateOf = async (key: string) =>
  (await pool.query('SELECT surfaces->>$1 AS s FROM people WHERE id = 11', [key])).rows[0].s as string;

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'diego@agentorgmesh.local', password: 'admin-dev-only' } });
  cookie = `aom_session=${login.cookies.find((c) => c.name === 'aom_session')!.value}`;
});

afterAll(async () => {
  for (const t of touched) {
    await pool.query('UPDATE people SET surfaces = jsonb_set(surfaces, $1, to_jsonb($2::text)) WHERE id = 11', [`{${t.key}}`, t.state]);
  }
  await app?.close();
  await pool?.end();
});

describe('pause and resume a tool', () => {
  it('a tool with no credential cannot be marked connected, however many times it is pressed', async () => {
    const key = 'zendesk';
    touched.push({ key, state: await stateOf(key) });
    await pool.query("UPDATE people SET surfaces = jsonb_set(surfaces, '{zendesk}', '\"absent\"') WHERE id = 11");
    for (let i = 0; i < 3; i += 1) {
      const res = await press(key);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Set up my agent');
    }
    expect(await stateOf(key)).toBe('absent');
  });

  it('pausing an active tool stops reading it in one press', async () => {
    const key = 'asana';
    touched.push({ key, state: await stateOf(key) });
    await pool.query("UPDATE people SET surfaces = jsonb_set(surfaces, '{asana}', '\"connected\"') WHERE id = 11");
    expect((await press(key)).statusCode).toBe(200);
    expect(await stateOf(key)).toBe('absent');
  });

  it('a push-based tool resumes only when real activity was pushed', async () => {
    const key = 'gemini-cli';
    const before = await stateOf(key);
    if (before === 'outOfScope') {
      expect((await press(key)).statusCode).toBe(200);
      expect(await stateOf(key)).toBe('outOfScope');
      return;
    }
    touched.push({ key, state: before });
    await pool.query('UPDATE people SET surfaces = jsonb_set(surfaces, $1, \'"absent"\') WHERE id = 11', [`{${key}}`]);
    const events = Number((await pool.query('SELECT count(*) FROM ingested_events WHERE person_id = 11 AND source = $1', [key])).rows[0].count);
    const res = await press(key);
    expect(res.statusCode).toBe(events > 0 ? 200 : 409);
  });
});
