-- 0006 — "Remove from my list" for Ask chats.
--
-- A chat is a grouping of audit_log rows, which are append-only (no UPDATE/DELETE grant, CLAUDE.md
-- rule 2) and are what the person asked about sees in "Who asked about me". So a chat is never
-- deleted: the asker can only hide it from their own lists. This table records that choice and
-- nothing else; the audit rows are untouched.

CREATE TABLE IF NOT EXISTS hidden_conversations (
  person_id        integer NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  hidden_at        timestamptz NOT NULL,
  PRIMARY KEY (person_id, conversation_id)
);

GRANT SELECT, INSERT ON hidden_conversations TO mesh_app;
