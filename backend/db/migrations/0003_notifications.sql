-- 0003 — "someone asked about you" notifications.
--
-- The notifications themselves are not stored: they are the audit_log rows where someone else
-- asked about one of this account's own people (read-only, already append-only). The only new
-- state is how far each account has read, so the bell can show an unread count.

CREATE TABLE IF NOT EXISTS notification_reads (
  account_id   integer PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  seen_through timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON notification_reads TO mesh_app;

-- The bell's query filters by target and orders by time.
CREATE INDEX IF NOT EXISTS audit_log_target_created_idx ON audit_log(target_person_id, created_at DESC);
