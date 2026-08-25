import pg from 'pg';
import { hashPassword } from '../src/domain/auth.js';
import { sslForConnectionString } from '../src/db/sslConfig.js';
import { DEFAULT_GRID } from '../src/domain/policy.js';
import {
  CLAIMS,
  ESCALATIONS,
  EVIDENCE,
  NEVER_INGESTED,
  ORG_MAIN_AGENT,
  PEOPLE,
  PERSON_RUNTIMES,
  RUNTIME_CATALOG,
  SURFACES,
} from '../src/data/seed.js';

const { Client } = pg;

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://mesh_admin:mesh_admin_dev_only@localhost:5433/agent_org_mesh';

const client = new Client({ connectionString: adminUrl, ssl: sslForConnectionString(adminUrl) });
await client.connect();

try {
  await client.query('BEGIN');

  // CASCADE resolves FK ordering for us regardless of the order listed here.
  await client.query(`TRUNCATE audit_log, person_runtimes, org_main_agent, policy_revisions,
    escalations, claims, evidence, runtime_catalog, people, surfaces_catalog, never_ingested,
    sessions, org_admins, organizations, accounts
    RESTART IDENTITY CASCADE`);

  // Platform: one demo account, given a real (dev-only) password so `npm run dev` has a
  // working login out of the box — see backend/src/domain/auth.ts. Not a secret worth
  // protecting: this whole database is thrown away and reseeded by this exact script.
  // The 40 seeded people below stay unlinked (account_id NULL) — structural chart
  // entries, reachable only through "My agent"'s free identity switcher, exactly as
  // before real per-person accounts existed.
  const DEV_PASSWORD = 'admin-dev-only';
  const { rows: accountRows } = await client.query(
    `INSERT INTO accounts (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    ['Jordan Ellis', 'jordan@agentorgmesh.local', hashPassword(DEV_PASSWORD)],
  );
  const accountId: number = accountRows[0].id;

  const { rows: orgRows } = await client.query(
    `INSERT INTO organizations (slug, name, created_at) VALUES ($1,$2,$3) RETURNING id`,
    ['northbeam', 'Northbeam', new Date().toISOString()],
  );
  const orgId: number = orgRows[0].id;
  await client.query(
    `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,'owner',$3)`,
    [orgId, accountId, new Date().toISOString()],
  );

  for (const s of SURFACES) {
    await client.query(
      'INSERT INTO surfaces_catalog (key, name, feeds_tier, reads, does_not_read) VALUES ($1,$2,$3,$4,$5)',
      [s.key, s.name, s.feedsTier, s.reads, s.doesNotRead],
    );
  }

  for (const n of NEVER_INGESTED) {
    await client.query('INSERT INTO never_ingested (name) VALUES ($1)', [n]);
  }

  // People first without manager_id, then patch it in — RAW is authored in id order but
  // FK targets can point at rows not yet inserted (e.g. an id-ascending manager chain
  // isn't guaranteed), so this two-pass insert avoids ordering the seed data by hand.
  for (const p of PEOPLE) {
    await client.query(
      `INSERT INTO people (id, org_id, name, title, team, manager_id, agent_deployed, surfaces)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7)`,
      [p.id, orgId, p.name, p.title, p.team, p.agentDeployed, JSON.stringify(p.surfaces)],
    );
  }
  for (const p of PEOPLE) {
    if (p.managerId != null) {
      await client.query('UPDATE people SET manager_id = $2 WHERE id = $1', [p.id, p.managerId]);
    }
  }
  // The demo roster uses explicit ids (1–40); bump the sequence so the next person the
  // admin adds — in this org or a new one — doesn't collide with them.
  await client.query(`SELECT setval('people_id_seq', (SELECT max(id) FROM people))`);

  for (const e of Object.values(EVIDENCE)) {
    await client.query(
      `INSERT INTO evidence (id, org_id, kind, title, connector, recorded_at, excerpt, note, external_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.id, orgId, e.kind, e.title, e.connector, e.recordedAt, e.excerpt, e.note, e.externalRef],
    );
  }

  for (const c of CLAIMS) {
    await client.query(
      `INSERT INTO claims (id, org_id, person_id, tier, data_class, text, evidence_id, source_surface, derived_at, superseded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.id, orgId, c.personId, c.tier, c.dataClass, c.text, c.evidenceId, c.sourceSurface, c.derivedAt, c.supersededBy],
    );
  }

  for (const e of ESCALATIONS) {
    await client.query(
      `INSERT INTO escalations
         (id, org_id, kind, title, detail, person_id, evidence_id, rule, path, status,
          acknowledged_by, acknowledged_at, resolved_by, resolved_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        e.id, orgId, e.kind, e.title, e.detail, e.personId, e.evidenceId, e.rule,
        JSON.stringify(e.path), e.status, e.acknowledgedBy, e.acknowledgedAt,
        e.resolvedBy, e.resolvedAt, e.createdAt,
      ],
    );
  }

  for (const r of RUNTIME_CATALOG) {
    await client.query(
      `INSERT INTO runtime_catalog (key, name, vendor, context_window, host, approved, blocked, reads, note, api_family, main_eligible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.key, r.name, r.vendor, r.contextWindow, r.host, r.approved, r.blocked, r.reads, r.note, r.apiFamily, r.mainEligible],
    );
  }

  for (const [personId, regs] of Object.entries(PERSON_RUNTIMES)) {
    for (const r of regs) {
      await client.query(
        'INSERT INTO person_runtimes (org_id, person_id, runtime_key, scope, added_at) VALUES ($1,$2,$3,$4,$5)',
        [orgId, Number(personId), r.runtimeKey, r.scope, r.addedAt],
      );
    }
  }

  await client.query(
    'INSERT INTO org_main_agent (org_id, runtime_key, scope, added_at) VALUES ($1,$2,$3,$4)',
    [orgId, ORG_MAIN_AGENT.runtimeKey, ORG_MAIN_AGENT.scope, ORG_MAIN_AGENT.addedAt],
  );

  await client.query(
    `INSERT INTO policy_revisions (org_id, grid, created_at, created_by, note)
     VALUES ($1,$2,$3,$4,$5)`,
    [orgId, JSON.stringify(DEFAULT_GRID), new Date().toISOString(), 'seed', 'Initial policy'],
  );

  await client.query('COMMIT');
  console.log(`seeded: demo dataset loaded (account ${accountId}, org ${orgId} "northbeam")`);
  console.log(`log in as jordan@agentorgmesh.local / ${DEV_PASSWORD}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
