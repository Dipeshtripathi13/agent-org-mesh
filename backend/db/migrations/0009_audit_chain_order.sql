-- 0009 — The audit chain gets an explicit order, because it never actually had one.
--
-- appendAuditEntry picked each row's predecessor with `ORDER BY created_at DESC, id DESC`, and
-- listAuditEntries/verifyAudit read the chain back with `ORDER BY created_at, id`. Those are
-- exact reverses, so they agree only while every new row is the greatest by (created_at, id).
-- Nothing guaranteed that: `created_at` is the app's own timestamp, and /api/agent/ask-multi
-- computes it once and writes one row per target with that identical value, four at a time. The
-- tiebreaker is then a random uuid, so a new row could sort *before* the row it points at.
--
-- Measured 2026-09-27, before this migration: one ask-multi about three people left the admin
-- audit screen reporting a failed tamper check in 3 of 5 runs, on untouched data — the worst
-- possible false alarm on the guarantee this table exists to provide (rule 2). Concurrent
-- appends that picked the same predecessor could also fork the chain outright.
--
-- seq is ordering metadata, deliberately NOT part of hashEntry(): hashing it would invalidate
-- every row already stored, which rule 2 forbids. It can't be used to forge an order either —
-- prev_hash/row_hash still are the chain, mesh_app holds no UPDATE on this table, and
-- verifyChain checks the links, so a rewritten seq shows up as a failure rather than hiding one.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq bigint;
CREATE SEQUENCE IF NOT EXISTS audit_log_seq_seq OWNED BY audit_log.seq;

-- Backfill in the order the links themselves define, not the order the broken sort implied:
-- walk each organization's chain from its root, then park anything the links can't reach
-- (rows already forked by the bug above) after it, deterministically.
WITH RECURSIVE chain AS (
  SELECT id, org_id, row_hash, 1 AS depth
    FROM audit_log WHERE prev_hash IS NULL
  UNION ALL
  SELECT a.id, a.org_id, a.row_hash, c.depth + 1
    FROM audit_log a
    JOIN chain c ON a.org_id = c.org_id AND a.prev_hash = c.row_hash
),
linked AS (
  SELECT id, row_number() OVER (ORDER BY org_id, depth, id) AS rn FROM chain
),
orphans AS (
  SELECT a.id,
         (SELECT count(*) FROM linked) + row_number() OVER (ORDER BY a.org_id, a.created_at, a.id) AS rn
    FROM audit_log a WHERE NOT EXISTS (SELECT 1 FROM linked l WHERE l.id = a.id)
)
UPDATE audit_log a SET seq = v.rn
  FROM (SELECT id, rn FROM linked UNION ALL SELECT id, rn FROM orphans) v
 WHERE a.id = v.id;

SELECT setval('audit_log_seq_seq', GREATEST((SELECT coalesce(max(seq), 0) FROM audit_log), 1));

ALTER TABLE audit_log ALTER COLUMN seq SET DEFAULT nextval('audit_log_seq_seq');
ALTER TABLE audit_log ALTER COLUMN seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_seq_idx ON audit_log (seq);
CREATE INDEX IF NOT EXISTS audit_log_org_seq_idx ON audit_log (org_id, seq);

-- INSERT alone isn't enough to draw from a sequence.
GRANT USAGE ON SEQUENCE audit_log_seq_seq TO mesh_app;

COMMENT ON COLUMN audit_log.seq IS
  'Insertion order for the hash chain. Read and appended in this order; never hashed (see migration 0009).';
