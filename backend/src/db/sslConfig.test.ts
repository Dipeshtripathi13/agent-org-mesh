import { describe, expect, it } from 'vitest';
import { sslForConnectionString } from './sslConfig.js';

describe('sslForConnectionString', () => {
  it('disables SSL for localhost — local docker-compose Postgres has none', () => {
    expect(sslForConnectionString('postgres://user:pass@localhost:5433/db')).toBe(false);
  });

  it('disables SSL for 127.0.0.1', () => {
    expect(sslForConnectionString('postgres://user:pass@127.0.0.1:5433/db')).toBe(false);
  });

  it('enables opportunistic SSL for a remote host', () => {
    expect(sslForConnectionString('postgres://user:pass@postgres-eblt.railway.internal:5432/db')).toEqual({ rejectUnauthorized: false });
  });

  it('enables opportunistic SSL for a public Railway proxy host', () => {
    expect(sslForConnectionString('postgres://user:pass@gondola.proxy.rlwy.net:32747/db')).toEqual({ rejectUnauthorized: false });
  });

  it('fails safe (no SSL) on an unparseable connection string rather than throwing', () => {
    expect(sslForConnectionString('not a url')).toBe(false);
  });
});
