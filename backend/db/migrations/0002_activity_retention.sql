-- 0002 — let the app delete pushed activity older than the published retention period.
--
-- ingested_events and account_ingested_events were insert-only for the app role. The privacy
-- policy now states that raw activity pushed by people's own tools is deleted after 90 days,
-- so src/db/retention.ts needs DELETE on exactly these two tables (and nothing else), plus an
-- index to find old rows without scanning every event.

GRANT DELETE ON ingested_events TO mesh_app;
GRANT DELETE ON account_ingested_events TO mesh_app;

CREATE INDEX IF NOT EXISTS ingested_events_occurred_idx ON ingested_events(occurred_at);
CREATE INDEX IF NOT EXISTS account_ingested_events_occurred_idx ON account_ingested_events(occurred_at);
