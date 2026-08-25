import pg from 'pg';
import { sslForConnectionString } from './sslConfig.js';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://mesh_app:mesh_app_dev_only@localhost:5433/agent_org_mesh';

export const pool = new Pool({ connectionString, ssl: sslForConnectionString(connectionString) });
