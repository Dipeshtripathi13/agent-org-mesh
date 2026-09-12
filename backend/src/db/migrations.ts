import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Numbered SQL migrations (release audit OPS-01). Replaces a schema file that could only
 * DROP SCHEMA and rebuild, plus one hand-run script per production change.
 *
 * Files live in backend/db/migrations as NNNN_name.sql and are applied in order, each in its own
 * transaction, and recorded in schema_migrations with a SHA-256 checksum. A Postgres advisory
 * lock serialises concurrent runs (two instances starting at once). An applied file that has
 * since changed stops the run rather than letting environments silently diverge.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

// Arbitrary but fixed: every runner against the same database contends for this one lock.
const LOCK_KEY = 804_120_917;

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const match = file.match(/^(\d{4})_([a-z0-9_]+)\.sql$/);
      if (!match) throw new Error(`migration file "${file}" must be named NNNN_lowercase_name.sql`);
      const sql = readFileSync(`${dir}/${file}`, 'utf8');
      return { version: Number(match[1]), name: match[2], file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 0001, 0002, … without gaps; found ${m.file} at position ${i + 1}`);
  });
  return migrations;
}

/** Objects the baseline creates. A database that has all of them but no schema_migrations
 *  table predates the runner and is adopted; one that has only some is refused. */
const BASELINE_TABLES = [
  'accounts', 'organizations', 'org_admins', 'sessions', 'people', 'surfaces_catalog', 'never_ingested',
  'evidence', 'claims', 'escalations', 'policy_revisions', 'audit_log', 'runtime_catalog', 'person_runtimes',
  'org_main_agent', 'account_main_agent', 'account_runtimes', 'account_ingest_tokens', 'account_ingested_events',
  'account_custom_agents', 'personal_asks', 'person_oauth_tokens', 'account_oauth_tokens', 'ingest_tokens',
  'ingested_events', 'email_tokens', 'invitations',
];
const BASELINE_COLUMNS: [string, string][] = [
  ['accounts', 'must_change_password'], ['accounts', 'email_verified_at'], ['accounts', 'email_verification_required'],
  ['organizations', 'plan'], ['audit_log', 'conversation_id'], ['org_main_agent', 'api_key_encrypted'],
  ['personal_asks', 'consulted_sources'],
];

export interface MigrationReport {
  adoptedBaseline: boolean;
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(
  client: pg.Client | pg.PoolClient,
  migrations: Migration[] = loadMigrations(),
): Promise<MigrationReport> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        adopted     boolean NOT NULL DEFAULT false
      )`);

    let adoptedBaseline = false;
    const { rows: recorded } = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    if (recorded.length === 0 && (await tableExists(client, 'organizations'))) {
      await adoptBaseline(client, migrations[0]);
      adoptedBaseline = true;
    }

    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map<number, string>(rows.map((r) => [Number(r.version), r.checksum as string]));
    for (const version of applied.keys()) {
      if (!migrations.some((m) => m.version === version)) {
        throw new Error(`schema_migrations records version ${version}, but no such migration file exists`);
      }
    }

    const newlyApplied: string[] = [];
    for (const m of migrations) {
      const checksum = applied.get(m.version);
      if (checksum !== undefined) {
        if (checksum !== m.checksum) {
          throw new Error(`migration ${m.file} was changed after it was applied (checksum mismatch) — add a new migration instead`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.file} failed and was rolled back: ${(err as Error).message}`);
      }
      newlyApplied.push(m.file);
    }
    return { adoptedBaseline, applied: newlyApplied, alreadyApplied: migrations.length - newlyApplied.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

async function tableExists(client: pg.Client | pg.PoolClient, table: string): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  return rows.length > 0;
}

async function adoptBaseline(client: pg.Client | pg.PoolClient, baseline: Migration | undefined): Promise<void> {
  if (!baseline || baseline.version !== 1) throw new Error('cannot adopt: migration 0001 (the baseline) is missing');
  const missing: string[] = [];
  for (const table of BASELINE_TABLES) if (!(await tableExists(client, table))) missing.push(table);
  for (const [table, column] of BASELINE_COLUMNS) {
    const { rows } = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
      [table, column],
    );
    if (rows.length === 0) missing.push(`${table}.${column}`);
  }
  if (missing.length > 0) {
    throw new Error(`this database predates the migration runner but is missing baseline objects (${missing.join(', ')}); bring it up to the baseline by hand before adopting`);
  }
  await client.query(
    'INSERT INTO schema_migrations (version, name, checksum, adopted) VALUES ($1, $2, $3, true)',
    [baseline.version, baseline.name, baseline.checksum],
  );
}
