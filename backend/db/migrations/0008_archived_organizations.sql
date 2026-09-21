-- 0008 — Deleting an organization archives it; the rows it owns are never deleted.
--
-- audit_log.org_id and policy_revisions.org_id reference organizations(id) with no cascade,
-- and mesh_app has INSERT/SELECT on both and nothing else (CLAUDE.md rules 2 and 3), so an
-- organization row can never actually be removed by the running app. Its own grants are
-- SELECT and INSERT too — deliberately, so the runtime role can't rewrite an org's plan or
-- name (see the plan-limits note) — which rules out an archived_at column on the table.
--
-- Hence a separate table: one row here means "archived", and it is the one write the app
-- needs. This is what makes the 402 from the organizations-per-account cap honest, since it
-- tells people to remove an organization they no longer need.

CREATE TABLE IF NOT EXISTS archived_organizations (
  org_id       integer PRIMARY KEY REFERENCES organizations(id),
  archived_at  timestamptz NOT NULL,
  archived_by  integer NOT NULL REFERENCES accounts(id)
);

GRANT SELECT, INSERT ON archived_organizations TO mesh_app;
