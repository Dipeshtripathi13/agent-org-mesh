import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Launch readiness (2026-09-14), mostly from the end-to-end test with real Claude Code and
 * Codex sessions. Diego = person 11 (seeded: Claude Code in scope, Codex out of scope).
 */

let app: FastifyInstance;
let pool: Pool;
let cookie = '';
let token = '';
const MARK = `launch-${Date.now()}`;
const restore: { key: string; state: string }[] = [];

const LAUNCH_SET = ['github', 'jira', 'linear', 'claude-code', 'codex', 'notion', 'calendar'];

const stateOf = async (key: string) =>
  (await pool.query('SELECT surfaces->>$1 AS s FROM people WHERE id = 11', [key])).rows[0].s as string;
const setState = async (key: string, state: string) => {
  if (!restore.some((r) => r.key === key)) restore.push({ key, state: await stateOf(key) });
  await pool.query('UPDATE people SET surfaces = jsonb_set(surfaces, $1, to_jsonb($2::text)) WHERE id = 11', [`{${key}}`, state]);
};
const push = (source: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/ingest/${source}`, remoteAddress: '10.8.0.1', headers: { authorization: `Bearer ${token}` }, payload: payload as never });
const eventsFor = async (source: string) =>
  Number((await pool.query('SELECT count(*) FROM ingested_events WHERE person_id = 11 AND source = $1 AND summary LIKE $2', [source, `%${MARK}%`])).rows[0].count);

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  ({ pool } = await import('./db/pool.js'));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'diego@agentorgmesh.local', password: 'admin-dev-only' } });
  cookie = `aom_session=${login.cookies.find((c) => c.name === 'aom_session')!.value}`;
  const minted = await app.inject({ method: 'POST', url: '/api/person/11/ingest-tokens', headers: { cookie }, payload: { label: 'launch test' } });
  token = minted.json().token;
});

afterAll(async () => {
  for (const r of restore) {
    await pool.query('UPDATE people SET surfaces = jsonb_set(surfaces, $1, to_jsonb($2::text)) WHERE id = 11', [`{${r.key}}`, r.state]);
  }
  await pool.query("DELETE FROM ingested_events WHERE person_id = 11 AND summary LIKE $1", [`%${MARK}%`]);
  await app?.close();
  await pool?.end();
});

describe('health', () => {
  it('answers without a session when the database is up', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('only the launch set of tools can be connected', () => {
  it('the catalog offers exactly the launch set; everything else is coming soon', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connectors/catalog', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const catalog = (res.json().catalog ?? res.json()) as { key: string; status: string }[];
    const available = catalog.filter((c) => c.status !== 'coming-soon').map((c) => c.key).sort();
    expect(available).toEqual([...LAUNCH_SET].sort());
  });

  it('connecting a coming-soon tool is refused by the server, not just hidden', async () => {
    for (const key of ['asana', 'gitlab', 'snowflake']) {
      const res = await app.inject({ method: 'POST', url: `/api/person/11/connectors/${key}`, headers: { cookie }, payload: { token: 'x', siteUrl: 'https://example.com' } });
      expect(res.statusCode, key).toBeGreaterThanOrEqual(400);
    }
  });

  it('activity pushed to a coming-soon tool is refused', async () => {
    const res = await push('gemini-cli', { kind: 'action', summary: `${MARK} gemini` });
    expect(res.statusCode).toBe(404);
    expect(await eventsFor('gemini-cli')).toBe(0);
  });
});

describe('pushed activity respects scope and pause', () => {
  it('a tool marked "not used for your role" stays off, and nothing is recorded', async () => {
    await setState('codex', 'outOfScope');
    const res = await push('codex', { tool_name: 'Bash', cwd: '/w', tool_input: { command: `echo ${MARK}` } });
    expect(res.statusCode).toBe(202);
    expect(res.json().recorded).toBe(false);
    expect(await stateOf('codex')).toBe('outOfScope');
    expect(await eventsFor('codex')).toBe(0);
  });

  it('a real Codex payload is recorded once the tool is in scope, and connects it', async () => {
    await setState('codex', 'absent');
    await pool.query("DELETE FROM ingested_events WHERE person_id = 11 AND source = 'codex'");
    const res = await push('codex', {
      session_id: '01a09bde', cwd: '/Users/someone/billing', hook_event_name: 'PostToolUse',
      tool_name: 'Bash', tool_input: { command: `python3 test_tax.py # ${MARK}` }, tool_response: '',
    });
    expect(res.statusCode).toBe(202);
    expect(await eventsFor('codex')).toBe(1);
    expect(await stateOf('codex')).toBe('connected');
    const row = (await pool.query("SELECT summary FROM ingested_events WHERE person_id = 11 AND source = 'codex' AND summary LIKE $1", [`%${MARK}%`])).rows[0];
    expect(row.summary).toBe(`Ran: python3 test_tax.py # ${MARK}`);
  });

  it('a tool paused in Controls stays paused when activity arrives, and records again after resuming', async () => {
    await setState('claude-code', 'connected');
    expect((await push('claude-code', { kind: 'action', summary: `${MARK} before pause` })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/person/11/surface/cycle', headers: { cookie }, payload: { surfaceKey: 'claude-code' } })).statusCode).toBe(200);
    expect(await stateOf('claude-code')).toBe('absent');

    const paused = await push('claude-code', { kind: 'action', summary: `${MARK} while paused` });
    expect(paused.json().recorded).toBe(false);
    expect(await stateOf('claude-code')).toBe('absent');
    expect((await pool.query('SELECT count(*) FROM ingested_events WHERE person_id = 11 AND summary = $1', [`${MARK} while paused`])).rows[0].count).toBe('0');

    expect((await app.inject({ method: 'POST', url: '/api/person/11/surface/cycle', headers: { cookie }, payload: { surfaceKey: 'claude-code' } })).statusCode).toBe(200);
    expect(await stateOf('claude-code')).toBe('connected');
    expect((await push('claude-code', { kind: 'action', summary: `${MARK} after resume` })).statusCode).toBe(202);
    expect((await pool.query('SELECT count(*) FROM ingested_events WHERE person_id = 11 AND summary = $1', [`${MARK} after resume`])).rows[0].count).toBe('1');
  });
});

describe('Google sign-in asks for Calendar only', () => {
  it('the consent request never includes the Gmail read scope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/oauth/gmail/start?personId=11', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    const scope = new URL(res.headers.location as string).searchParams.get('scope') ?? '';
    expect(scope).toContain('calendar.readonly');
    expect(scope).not.toContain('gmail');
  });
});

describe('no invented sub-agent activity', () => {
  it('asking a sub-agent without a real activity source says so instead of making something up', async () => {
    // Register one for Diego so the query really runs (he only has Claude Code in the seed).
    const registered = await app.inject({ method: 'POST', url: '/api/person/11/runtimes', headers: { cookie }, payload: { runtimeKey: 'chatgpt' } });
    expect([200, 409]).toContain(registered.statusCode);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/person/11/runtimes/chatgpt/query', headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { text: string; real: boolean };
      expect(body.real).toBe(false);
      expect(body.text).toMatch(/nothing real to show/);
      expect(body.text).not.toMatch(/simulated|reports for|drafted|summarised|outlined|suggested completions/i);
    } finally {
      await app.inject({ method: 'DELETE', url: '/api/person/11/runtimes/chatgpt', headers: { cookie } });
    }
  });
});
