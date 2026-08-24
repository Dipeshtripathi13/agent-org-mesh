import pg from 'pg';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://mesh_app:mesh_app_dev_only@localhost:5433/agent_org_mesh';

export const pool = new Pool({ connectionString });
