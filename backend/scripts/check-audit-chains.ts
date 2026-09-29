/**
 * Chain-health check for every organization's audit log.
 *
 * Why this exists: until 2026-09-27 the chain had no explicit order. `appendAuditEntry`
 * picked a predecessor by `(created_at DESC, id DESC)` while the verifier read by
 * `(created_at, id)`, and `/api/agent/ask-multi` writes one row per target with a single
 * timestamp, four at a time — so a new row could sort before the row it pointed at. One
 * ask-multi about three people broke the check in 3 of 5 runs on a fresh organization, and
 * concurrent appends could fork the chain outright. Migration 0009 fixed the ordering, but
 * damage already written can never be repaired: audit rows are append-only by design (rule 2),
 * so a forked organization reports a failure forever.
 *
 * That makes "the check failed" useless on its own, which is what this script is for. It
 * separates the one finding that means someone changed stored history from the ones that are
 * permanent scar tissue from that defect:
 *
 *   ALTERED    a row's contents no longer match its own hash   -> real tampering, investigate
 *   FORKED     two rows claim the same predecessor             -> the 0009 defect, permanent
 *   ORPHANED   a row points at a hash no row here has          -> the 0009 defect, permanent
 *   MISORDERED links are sound, only the read order was wrong  -> benign; 0009 fixes it
 *
 * Exits non-zero only for ALTERED. The rest are reported loudly and counted, but they are
 * history that cannot be rewritten, so failing a deploy on them would be noise forever.
 *
 * Reads only — no UPDATE, no DELETE, nothing to grant. Run it against production the same way
 * as the connector check:
 *
 *   railway ssh 'cd /app/backend && npx tsx scripts/check-audit-chains.ts'
 */
import { diagnoseChain } from '../src/domain/audit.js';
import { listAuditEntries } from '../src/db/repo.js';
import { pool } from '../src/db/pool.js';

const { rows: orgs } = await pool.query<{ org_id: number; name: string; n: number }>(
  `SELECT a.org_id, o.name, count(*)::int AS n
     FROM audit_log a JOIN organizations o ON o.id = a.org_id
    GROUP BY a.org_id, o.name ORDER BY a.org_id`,
);

if (orgs.length === 0) console.log('No organization has any audit entries yet.');

let altered = 0;
let damaged = 0;
for (const org of orgs) {
  const d = diagnoseChain(await listAuditEntries(org.org_id));
  const label = `org ${org.org_id} (${org.name}), ${d.entries} entries`;
  if (d.ok) {
    console.log(`  OK         ${label}`);
    continue;
  }
  if (d.altered.length > 0) {
    altered += 1;
    console.log(`  ALTERED    ${label} — ${d.altered.length} row(s) no longer match their own hash: ${d.altered.join(', ')}`);
  }
  if (d.forkedAt.length > 0 || d.orphans.length > 0) {
    damaged += 1;
    const parts = [
      d.forkedAt.length > 0 ? `${d.forkedAt.length} fork(s)` : null,
      d.orphans.length > 0 ? `${d.orphans.length} orphan(s)` : null,
      d.roots === 1 ? null : `${d.roots} roots`,
    ].filter(Boolean).join(', ');
    console.log(`  DAMAGED    ${label} — ${parts}; pre-0009 defect, cannot be repaired`);
  }
  if (d.reorderable) {
    console.log(`  MISORDERED ${label} — links are sound, only the order was wrong (0009 fixes this)`);
  }
}

console.log(
  `\n${orgs.length} organization(s) checked · ${altered} with altered rows · ${damaged} with permanent pre-0009 damage`,
);
if (altered > 0) console.log('\nALTERED means stored history was changed. That is not the old ordering defect — investigate.');

await pool.end();
process.exit(altered > 0 ? 1 : 0);
