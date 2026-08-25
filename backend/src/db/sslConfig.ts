/**
 * Shared by pool.ts (the running app) and scripts/migrate.ts + scripts/seed-db.ts (the
 * one-time admin scripts) — all three construct their own pg Client/Pool independently,
 * so the SSL decision has to be made the same way in each rather than only once.
 *
 * `pg` only attempts a TLS handshake when explicitly told to; by default a connection
 * string with no `ssl` option is plain TCP even against a TLS-capable server. Found
 * during a security audit: none of the three connections here set one at all, so every
 * migrate/seed run this project has ever done — including over Railway's public TCP
 * proxy — travelled in plaintext, admin password included.
 *
 * `rejectUnauthorized: false` rather than full chain verification: managed Postgres
 * providers (Railway's postgres-ssl image included) commonly terminate TLS with a
 * certificate that doesn't chain to a public root CA. This still defeats passive
 * eavesdropping (the actual risk this closes), just not a full MITM with a forged cert —
 * a real gap, but a strict improvement over today's plaintext-by-default.
 *
 * Local dev (docker-compose's plain, non-TLS Postgres image) would simply fail to
 * connect at all if forced onto TLS, so this only enables it for anything that isn't
 * localhost/127.0.0.1.
 */
export function sslForConnectionString(connectionString: string): false | { rejectUnauthorized: boolean } {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  return { rejectUnauthorized: false };
}
