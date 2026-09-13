import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, MIGRATIONS_DIR, runMigrations, type MigrationReport } from './migrations.js';

/**
 * The migration runner against a real Postgres (release audit OPS-01), on its own disposable
 * database so it can drop and recreate freely. Expectations are derived from whatever migrations
 * exist in backend/db/migrations, so adding a migration never breaks these tests.
 */

const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
const DB = 'agent_org_mesh_migrations_test';
const dbUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${DB}`; return u.toString(); })();
const maintenanceUrl = (() => { const u = new URL(adminUrl); u.pathname = '/postgres'; return u.toString(); })();

const REAL = loadMigrations();
const REAL_FILES = REAL.map((m) => m.file);
const pad = (n: number) => String(n).padStart(4, '0');
const NEXT = pad(REAL.length + 1);
const AFTER_NEXT = pad(REAL.length + 2);

const tempDirs: string[] = [];
const open: pg.Client[] = [];

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  open.push(client);
  return client;
}

async function recreateDatabase(): Promise<void> {
  while (open.length) await open.pop()!.end().catch(() => {});
  const admin = new pg.Client({ connectionString: maintenanceUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DB}"`);
  await admin.end();
}

/** A copy of the real migrations directory plus extra files, for testing later migrations. */
function migrationsWith(extra: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'aom-migrations-'));
  tempDirs.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  for (const [file, sql] of Object.entries(extra)) writeFileSync(join(dir, file), sql);
  return dir;
}

const tableExists = async (client: pg.Client, table: string) =>
  (await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1", [table])).rows.length > 0;

beforeEach(recreateDatabase);

afterAll(async () => {
  while (open.length) await open.pop()!.end().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: maintenanceUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin.end();
});

describe('migration runner', () => {
  it('builds an empty database from every migration, then does nothing on a second run', async () => {
    const client = await connect();
    expect(await runMigrations(client)).toEqual({ adoptedBaseline: false, applied: REAL_FILES, alreadyApplied: 0 });
    for (const table of ['accounts', 'invitations', 'email_tokens', 'audit_log']) expect(await tableExists(client, table)).toBe(true);

    expect(await runMigrations(client)).toEqual({ adoptedBaseline: false, applied: [], alreadyApplied: REAL.length });
    const rows = (await client.query('SELECT version, name, adopted FROM schema_migrations ORDER BY version')).rows;
    expect(rows).toEqual(REAL.map((m) => ({ version: m.version, name: m.name, adopted: false })));
  });

  it('applies a new migration exactly once', async () => {
    const client = await connect();
    const dir = migrationsWith({ [`${NEXT}_add_probe_table.sql`]: 'CREATE TABLE probe_table (id integer PRIMARY KEY);' });
    expect((await runMigrations(client, loadMigrations(dir))).applied).toEqual([...REAL_FILES, `${NEXT}_add_probe_table.sql`]);
    expect(await tableExists(client, 'probe_table')).toBe(true);
    expect((await runMigrations(client, loadMigrations(dir))).applied).toEqual([]);
  });

  it('rolls a failing migration back completely and records nothing', async () => {
    const client = await connect();
    await runMigrations(client);
    const dir = migrationsWith({
      [`${NEXT}_half_finished.sql`]: 'CREATE TABLE half_finished (id integer);\nSELECT column_that_does_not_exist FROM accounts;',
    });
    await expect(runMigrations(client, loadMigrations(dir))).rejects.toThrow(new RegExp(`${NEXT}_half_finished\\.sql failed and was rolled back`));
    expect(await tableExists(client, 'half_finished')).toBe(false);
    expect((await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)).toEqual(REAL.map((m) => m.version));
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const client = await connect();
    const file = `${NEXT}_add_probe_table.sql`;
    const dir = migrationsWith({ [file]: 'CREATE TABLE probe_table (id integer PRIMARY KEY);' });
    await runMigrations(client, loadMigrations(dir));
    writeFileSync(join(dir, file), 'CREATE TABLE probe_table (id integer PRIMARY KEY, extra text);');
    await expect(runMigrations(client, loadMigrations(dir))).rejects.toThrow(new RegExp(`${file.replace('.', '\\.')} was changed after it was applied`));
  });

  it('refuses when the database records a migration that no longer exists', async () => {
    const client = await connect();
    await runMigrations(client, loadMigrations(migrationsWith({ [`${NEXT}_add_probe_table.sql`]: 'CREATE TABLE probe_table (id integer);' })));
    await expect(runMigrations(client)).rejects.toThrow(new RegExp(`records version ${REAL.length + 1}, but no such migration file exists`));
  });

  it('adopts a database that already has the baseline schema, then applies what came after it (production)', async () => {
    const client = await connect();
    await client.query(REAL[0].sql);
    await client.query("INSERT INTO organizations (slug, name, created_at) VALUES ('existing', 'Existing Org', now())");

    const report = await runMigrations(client);
    expect(report).toEqual({ adoptedBaseline: true, applied: REAL_FILES.slice(1), alreadyApplied: 1 });
    expect((await client.query('SELECT adopted FROM schema_migrations WHERE version = 1')).rows[0].adopted).toBe(true);
    expect((await client.query("SELECT count(*)::int AS n FROM organizations WHERE slug = 'existing'")).rows[0].n).toBe(1);
  });

  it('refuses to adopt a database that has only part of the schema', async () => {
    const client = await connect();
    await client.query('CREATE TABLE organizations (id serial PRIMARY KEY)');
    await expect(runMigrations(client)).rejects.toThrow(/missing baseline objects \(accounts,/);
    expect((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(0);
  });

  it('serialises two runners starting at the same time', async () => {
    const [a, b] = [await connect(), await connect()];
    const reports: MigrationReport[] = await Promise.all([runMigrations(a), runMigrations(b)]);
    expect(reports.flatMap((r) => r.applied)).toEqual(REAL_FILES);
    expect((await a.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(REAL.length);
  });
});

describe('loading migration files', () => {
  it('rejects badly named files and gaps in numbering', () => {
    expect(() => loadMigrations(migrationsWith({ 'add_thing.sql': 'SELECT 1;' }))).toThrow(/must be named NNNN_lowercase_name\.sql/);
    expect(() => loadMigrations(migrationsWith({ [`${AFTER_NEXT}_skipped_one.sql`]: 'SELECT 1;' }))).toThrow(/without gaps/);
  });
});
