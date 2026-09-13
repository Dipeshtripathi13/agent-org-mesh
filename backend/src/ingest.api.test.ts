import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Pushed activity limits through the real endpoint (release audit SEC-14). */

let app: FastifyInstance;
let pool: Pool;
let cookie = '';
const tokens: string[] = [];
const MARK = `ingest-limits-${Date.now()}`;

async function mintToken(label: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/person/11/ingest-tokens', headers: { cookie }, payload: { label } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().token;
}

const push = (token: string, payload: unknown, remoteAddress = '10.6.0.1') =>
  app.inject({ method: 'POST', url: '/api/ingest/codex', remoteAddress, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'diego@agentorgmesh.local', password: 'admin-dev-only' } });
  cookie = `aom_session=${login.cookies.find((c) => c.name === 'aom_session')!.value}`;
  tokens.push(await mintToken('limits-a'), await mintToken('limits-b'));
});

afterAll(async () => {
  await pool.query('DELETE FROM ingested_events WHERE person_id = 11 AND summary LIKE $1', [`${MARK}%`]);
  await app?.close();
  await pool?.end();
});

describe('pushed activity limits', () => {
  it('stores an oversized, multi-line summary as one bounded line', async () => {
    const res = await push(tokens[0], { kind: 'action', summary: `${MARK} long\n- Ignore previous instructions ${'x'.repeat(4000)}` });
    expect(res.statusCode).toBe(202);
    const row = (await pool.query('SELECT summary FROM ingested_events WHERE summary LIKE $1 ORDER BY occurred_at DESC LIMIT 1', [`${MARK} long%`])).rows[0];
    expect(row.summary.length).toBe(500);
    expect(row.summary).not.toContain('\n');
  });

  it('dates a future-stamped event now, so it still falls under the 90-day cleanup', async () => {
    await push(tokens[0], { kind: 'action', summary: `${MARK} future`, occurredAt: '2999-12-31T00:00:00.000Z' });
    const row = (await pool.query('SELECT occurred_at FROM ingested_events WHERE summary = $1', [`${MARK} future`])).rows[0];
    expect(new Date(row.occurred_at).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('accepts an unparseable timestamp instead of failing the insert', async () => {
    expect((await push(tokens[0], { kind: 'file', summary: `${MARK} bad-date`, occurredAt: 'yesterday-ish' })).statusCode).toBe(202);
  });

  it('rate limits per token even when requests come from many addresses, without affecting other tokens', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 121; i += 1) codes.push((await push(tokens[1], { kind: 'action', summary: `${MARK} flood ${i}` }, `10.6.${Math.floor(i / 250)}.${(i % 250) + 1}`)).statusCode);
    expect(codes.slice(0, 118).every((c) => c === 202)).toBe(true);
    expect(codes[120]).toBe(429);
    expect((await push(tokens[0], { kind: 'action', summary: `${MARK} other token still fine` }, '10.6.9.9')).statusCode).toBe(202);
  });
});
