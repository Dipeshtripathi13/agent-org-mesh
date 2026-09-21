-- 0007 — Removing someone from a chart marks them removed; it never deletes their record.
--
-- `DELETE FROM people` could only ever work for someone with no history at all: claims,
-- evidence, escalations and audit_log all reference people(id) with no cascade, and mesh_app
-- has no DELETE grant on any of them (CLAUDE.md rules 2 and 3). So removing anyone who had
-- ever been asked about raised a raw foreign-key error and returned 500 — found 2026-09-20
-- against a real seeded person with four claims.
--
-- Marking them instead is also the honest behaviour: what the people they answered can see
-- in "Who asked about me" must survive someone leaving the company.

ALTER TABLE people ADD COLUMN IF NOT EXISTS removed_at timestamptz;

-- Every roster read filters on this, so it's worth an index rather than a sequential scan.
CREATE INDEX IF NOT EXISTS people_org_active_idx ON people (org_id) WHERE removed_at IS NULL;

COMMENT ON COLUMN people.removed_at IS
  'Set when an admin removes this person from the chart. Their claims, evidence and audit rows stay; every roster, seat count and identity lookup skips them.';
