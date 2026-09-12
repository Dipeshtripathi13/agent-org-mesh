-- Agent Org Mesh — schema.
--
-- Run as the admin role (mesh_admin / POSTGRES_USER from docker-compose).
-- Creates the app-runtime role `mesh_app` with the minimum grants it needs,
-- and — per CLAUDE.md rule 2 — locks the audit log down at the database
-- level: mesh_app gets INSERT and SELECT on audit_log, nothing else.
-- policy_revisions gets the same treatment for rule 3 (immutable revisions):
-- editing writes a new row, nothing updates or deletes an old one.
--
-- Multi-tenant: an org can have several admins (org_admins, role-based — owner/admin/
-- viewer), and one admin can belong to several organizations. `accounts` is the one real
-- login identity for every human, admin or employee or both — a `people` row (an org
-- chart entry) optionally links to one via `people.account_id`, and since that column
-- isn't unique, the same account can be linked from `people` rows in more than one org
-- (real multi-org membership: one login, a separate org-scoped profile per org). None of
-- this is scoped to a single org — `accounts`, `organizations`, and `org_admins` are
-- platform-level; everything an org actually contains — people, claims, evidence,
-- escalations, runtime registrations, policy revisions, audit entries — carries an org_id.
-- surfaces_catalog, never_ingested, and runtime_catalog stay global: they're
-- the platform's connector/runtime product surface, the same for every org.

-- This is a reset, not an incremental migration: it rebuilds from a clean slate rather
-- than growing a chain of ALTERs. That was safe by default before this app had a real
-- prod deployment with real signups behind it — it no longer is. backend/scripts/
-- migrate.ts refuses to run this against a database that already has organizations in
-- it unless CONFIRM_RESET=yes is set explicitly; a genuinely additive change against a
-- live database (like the one that added the `plan` column below) should be applied by
-- hand as its own ALTER, not by loosening that guard. Re-seed afterward with
-- `npm run db:seed`.
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

/* ---------- app role ---------- */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mesh_app') THEN
    CREATE ROLE mesh_app LOGIN PASSWORD 'mesh_app_dev_only';
  END IF;
END
$$;

-- current_database() rather than a hardcoded name — the local docker-compose database is
-- always agent_org_mesh, but a managed Postgres instance (Railway, etc.) names its
-- database whatever it wants (e.g. "railway"), and this has to work against either.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mesh_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO mesh_app;

/* ---------- platform: accounts & organizations ----------
   `accounts` is the one real login identity in this app — a human, not a role. The same
   account can hold an org_admins row (platform governance for an org) and/or be linked
   from one or more people rows (an org-chart identity, one per org) at the same time;
   nothing here forces "admin" and "person" to be different humans. */

CREATE TABLE IF NOT EXISTS accounts (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL UNIQUE,
  -- 'scrypt$<saltHex>$<hashHex>', see backend/src/domain/auth.ts. Nullable, but nothing
  -- writes null today: all three insertAccount call sites (signup, org-admin invite, and
  -- adding a person with an email) set a real hash, the latter two a generated temp
  -- password with must_change_password below. This comment used to claim a just-invited
  -- admin had null here, which was never true and would mislead anyone building a "claim
  -- your account" flow on top of it. The column stays nullable for the future "SSO-only
  -- account" state — an account that authenticates entirely through an identity provider
  -- and never needs a password at all. Until SSO lands, treat null as unreachable rather
  -- than as a state to handle: login and change-password both already refuse it (a
  -- constant-time dummy comparison on login, so a null hash can't be probed by timing).
  password_hash  text,
  -- True while the current password is a system-generated temp one (an invite, or an
  -- admin-initiated reset) that the account holder never chose. The app forces a change
  -- before anything else is usable, then clears this — so a temp password can't quietly
  -- become someone's permanent one, which is exactly what happened before this existed
  -- (change-password had no UI at all, so an invited person literally could not change
  -- it). Never set for a self-serve signup: that password was chosen by its owner.
  must_change_password boolean NOT NULL DEFAULT false,
  -- Set only when ownership of this address has actually been proven — today, by accepting
  -- an invitation that was really delivered to it by email. Recorded, not yet required at
  -- signup: production can't send email until Resend is configured (release audit SEC-08).
  email_verified_at    timestamptz
);

CREATE TABLE IF NOT EXISTS organizations (
  id              serial PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL,
  -- 'starter' | 'business' | 'enterprise' — see backend/src/db/repo.ts's PLAN_LIMITS for
  -- what each actually caps. No billing integration exists yet, so moving an org off
  -- 'starter' is a manual UPDATE today, not something any endpoint does automatically.
  plan            text NOT NULL DEFAULT 'starter'
);

-- Real multi-admin RBAC: which accounts can act on which org, and how much they can do.
-- 'owner' can invite/remove/promote other admins for this org (and can't be removed as
-- the last owner); 'admin' can do everything else that mutates org state; 'viewer' can
-- see admin screens but not change anything. An org can have more than one admin, and the
-- same account can be an admin for more than one org.
CREATE TABLE IF NOT EXISTS org_admins (
  org_id      integer NOT NULL REFERENCES organizations(id),
  account_id  integer NOT NULL REFERENCES accounts(id),
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  added_at    timestamptz NOT NULL,
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX IF NOT EXISTS org_admins_account_idx ON org_admins(account_id);

-- Real server-side sessions, not JWTs — revocable by setting revoked_at, inspectable in
-- the DB, same shape as ingest_tokens below: only token_hash is ever stored, the raw
-- token lives in an httpOnly cookie and is never persisted anywhere. One session type for
-- every login, admin or employee or both — which panels/orgs it can act on is resolved
-- from org_admins and people.account_id at request time, not baked into the session row.
-- elevated_until: step-up auth. A normal login only ever grants baseline ("My agent")
-- access; touching anything admin-scoped (org creation, the Admin panel, requireOrgRole-
-- gated endpoints) additionally requires re-entering the account's password within the
-- last window via POST /api/auth/step-up, which stamps this column. NULL or expired means
-- not elevated — checked server-side in requireOrgRole itself, never trusted from the
-- client, same posture as every other auth boundary in this codebase (CLAUDE.md rule 7).
CREATE TABLE IF NOT EXISTS sessions (
  id             uuid PRIMARY KEY,
  account_id     integer NOT NULL REFERENCES accounts(id),
  token_hash     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  elevated_until timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);

/* ---------- org ---------- */

CREATE TABLE IF NOT EXISTS people (
  id             serial PRIMARY KEY,
  org_id         integer NOT NULL REFERENCES organizations(id),
  name           text NOT NULL,
  title          text NOT NULL,
  team           text NOT NULL,
  manager_id     integer REFERENCES people(id),
  agent_deployed boolean NOT NULL,
  -- Record<SurfaceKey, SurfaceState> — kept as jsonb to mirror the domain type
  -- shape exactly; coverage.ts consumes it as-is once loaded.
  surfaces       jsonb NOT NULL,
  -- Real login for this org-chart entry, when one exists. Nullable and NOT unique: most
  -- of the seeded roster has no account at all (a structural chart entry, reachable only
  -- through "My agent"'s free identity switcher, exactly as before this column existed),
  -- and the same account can be linked from people rows in different orgs — that's what
  -- makes one human's membership in more than one organization real rather than a
  -- reused name. A person row is always org-scoped (title/team/manager only make sense
  -- within one chart), so multi-org membership is "two people rows, one account", never
  -- a single row that spans orgs.
  account_id     integer REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS people_org_idx ON people(org_id);
CREATE INDEX IF NOT EXISTS people_account_idx ON people(account_id);

-- Global product surface — the same six connector types for every org.
CREATE TABLE IF NOT EXISTS surfaces_catalog (
  key            text PRIMARY KEY,
  name           text NOT NULL,
  feeds_tier     text NOT NULL,
  reads          text NOT NULL,
  does_not_read  text NOT NULL
);

-- Excluded classes, enforced structurally: these rows are the entire
-- implementation. There is no flag anywhere that turns one into a connector.
-- Global — the same categories are excluded for every org on the platform.
CREATE TABLE IF NOT EXISTS never_ingested (
  name text PRIMARY KEY
);

/* ---------- evidence & claims ---------- */

CREATE TABLE IF NOT EXISTS evidence (
  id            text PRIMARY KEY,
  org_id        integer NOT NULL REFERENCES organizations(id),
  kind          text NOT NULL,
  title         text NOT NULL,
  connector     text NOT NULL,
  recorded_at   timestamptz NOT NULL,
  excerpt       text NOT NULL,
  note          text NOT NULL,
  external_ref  text NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_org_idx ON evidence(org_id);

CREATE TABLE IF NOT EXISTS claims (
  id              text PRIMARY KEY,
  org_id          integer NOT NULL REFERENCES organizations(id),
  person_id       integer NOT NULL REFERENCES people(id),
  tier            text NOT NULL,
  data_class      text NOT NULL,
  text            text NOT NULL,
  evidence_id     text REFERENCES evidence(id),
  source_surface  text NOT NULL,
  derived_at      timestamptz NOT NULL,
  -- Corrections supersede rather than mutate the claim in place.
  superseded_by   text
);
CREATE INDEX IF NOT EXISTS claims_org_idx ON claims(org_id);
CREATE INDEX IF NOT EXISTS claims_person_idx ON claims(person_id);

/* ---------- escalations ---------- */

-- Real triage state, not narrative content — see docs/escalation-triage.md. `age_days`
-- is deliberately absent: it's derived from created_at at read time (CLAUDE.md rule 6),
-- never stored. `path` is {personId,name}[], resolved from the org graph at detection
-- time — the personId lets an acknowledge/resolve request check structurally whether the
-- actor is actually on the path, rather than string-matching a name.
CREATE TABLE IF NOT EXISTS escalations (
  id               text PRIMARY KEY,
  org_id           integer NOT NULL REFERENCES organizations(id),
  kind             text NOT NULL,
  title            text NOT NULL,
  detail           text NOT NULL,
  person_id        integer NOT NULL REFERENCES people(id),
  evidence_id      text REFERENCES evidence(id),
  rule             text NOT NULL,
  path             jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by  integer REFERENCES people(id),
  acknowledged_at  timestamptz,
  resolved_by      integer REFERENCES people(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escalations_org_idx ON escalations(org_id);
CREATE INDEX IF NOT EXISTS escalations_person_idx ON escalations(person_id);

/* ---------- policy — immutable revisions ---------- */

CREATE TABLE IF NOT EXISTS policy_revisions (
  id          serial PRIMARY KEY,
  org_id      integer NOT NULL REFERENCES organizations(id),
  grid        jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  created_by  text NOT NULL,
  note        text NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_revisions_org_idx ON policy_revisions(org_id);

/* ---------- audit — append-only ---------- */

CREATE TABLE IF NOT EXISTS audit_log (
  id                  uuid PRIMARY KEY,
  org_id              integer NOT NULL REFERENCES organizations(id),
  requester_id        integer NOT NULL,
  requester_role      text NOT NULL,
  target_person_id    integer NOT NULL REFERENCES people(id),
  question            text NOT NULL,
  -- json, not jsonb: jsonb canonicalizes key order on storage, which would make the
  -- stored row re-serialize differently than the object that was hashed at append time
  -- and break every row's hash. json stores the exact text handed to it, so a
  -- JSON.parse → JSON.stringify round trip reproduces byte-identical key order.
  snapshot            json NOT NULL,
  policy_revision_id  integer NOT NULL REFERENCES policy_revisions(id),
  subject_notified_at timestamptz NOT NULL,
  created_at          timestamptz NOT NULL,
  prev_hash           text,
  row_hash            text NOT NULL,
  -- Groups a person's own real "Self" asks into chats (My agent → Ask yourself). Pure UI
  -- grouping metadata, deliberately outside the tamper-evident chain: hashEntry() in
  -- audit.ts allow-lists the exact fields it hashes and this isn't one of them, so it can
  -- never affect row_hash or verifyChain. Null for every ask that isn't part of a chat
  -- (all cross-person Ask activity, and anything asked before this column existed).
  conversation_id     uuid
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log(target_person_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS audit_log_conversation_idx ON audit_log(conversation_id);

/* ---------- agent runtimes ---------- */

-- Global catalog — every org registers from the same list of runtimes.
CREATE TABLE IF NOT EXISTS runtime_catalog (
  key             text PRIMARY KEY,
  name            text NOT NULL,
  vendor          text NOT NULL,
  context_window  text NOT NULL,
  host            text NOT NULL,
  approved        boolean NOT NULL,
  blocked         boolean NOT NULL,
  reads           text NOT NULL,
  note            text NOT NULL,
  -- Which real ModelProvider adapter (backend/src/integrations/) actually answers
  -- questions when this runtime is someone's main agent — 'anthropic', 'openai-compatible'
  -- (covers ChatGPT and any open-source/self-hosted model behind the same wire protocol),
  -- or 'unsupported' (no real integration path; stays a labelled simulation, same as
  -- today). Never a permission a policy edit could grant — see docs/agent-to-agent-
  -- communication.md's model-agnostic main agents section.
  api_family      text NOT NULL DEFAULT 'unsupported',
  -- Orthogonal to api_family: is this entry a sensible org-facing aggregator at all.
  -- claude-code has a real api_family ('anthropic') but stays sub-agent-only — it's a
  -- development tool scoped to GitHub/Jira, never meant to be someone's main agent.
  main_eligible   boolean NOT NULL DEFAULT false
);

-- Every row here is a personal sub-agent — a tool the org's one main agent (see
-- org_main_agent below) can query for a status summary, but that never touches org
-- surfaces and nobody outside the person can reach directly.
CREATE TABLE IF NOT EXISTS person_runtimes (
  org_id       integer NOT NULL REFERENCES organizations(id),
  person_id    integer NOT NULL REFERENCES people(id),
  runtime_key  text NOT NULL REFERENCES runtime_catalog(key),
  scope        text NOT NULL,
  added_at     date NOT NULL,
  PRIMARY KEY (person_id, runtime_key)
);
CREATE INDEX IF NOT EXISTS person_runtimes_org_idx ON person_runtimes(org_id);

-- The one main/aggregator agent for the whole organization — set by an org admin
-- (server.ts's POST /api/organizations/:orgId/main-agent, requireOrgRole 'admin'), never
-- by an individual person. org_id as the primary key makes "one per org" structural.
-- Everyone in the org reads the same registration; nobody can register their own.
--
-- api_key_encrypted/base_url/model: the org's own optional credential override, so
-- different organizations can each bring their own provider key or point at their own
-- self-hosted endpoint instead of sharing this deployment's platform-wide env var default.
-- All NULL (the default) means "use the platform default," unchanged from before this
-- existed. Only the key is encrypted (domain/crypto.ts, AES-256-GCM) — base_url/model
-- aren't secrets and an admin needs to see them to edit; the key must never be returned
-- decrypted by any API response (server.ts's GET handler exposes only a boolean).
CREATE TABLE IF NOT EXISTS org_main_agent (
  org_id             integer PRIMARY KEY REFERENCES organizations(id),
  runtime_key        text NOT NULL REFERENCES runtime_catalog(key),
  scope              text NOT NULL,
  added_at           date NOT NULL,
  api_key_encrypted  text,
  base_url           text,
  model              text
);

-- The personal counterpart to org_main_agent, for an account connected to no organization
-- at all — set by the account itself (no admin, no elevation; it's only ever your own
-- credential). account_id as the primary key makes "one per account" structural, same
-- reasoning as org_id above. No `scope` column: there's no IT/Security approval workflow
-- for a personal credential the way there is for an org-wide one — always immediately
-- usable the moment it's set.
CREATE TABLE IF NOT EXISTS account_main_agent (
  account_id         integer PRIMARY KEY REFERENCES accounts(id),
  runtime_key        text NOT NULL REFERENCES runtime_catalog(key),
  added_at           date NOT NULL,
  api_key_encrypted  text,
  base_url           text,
  model              text
);

-- The personal counterpart to person_runtimes — a sub-agent (Claude Code, Codex CLI,
-- Gemini CLI) registered by an account with no organization at all, same "never touches
-- org surfaces" meaning, just nothing to attach an org_id to.
CREATE TABLE IF NOT EXISTS account_runtimes (
  account_id   integer NOT NULL REFERENCES accounts(id),
  runtime_key  text NOT NULL REFERENCES runtime_catalog(key),
  scope        text NOT NULL,
  added_at     date NOT NULL,
  PRIMARY KEY (account_id, runtime_key)
);

-- The personal counterpart to ingest_tokens/ingested_events (see that pair's own comment
-- above self-service tool connections) — a personal account's own bearer token for
-- POST /api/ingest/:source, and the raw pushed activity it authenticates.
CREATE TABLE IF NOT EXISTS account_ingest_tokens (
  id            uuid PRIMARY KEY,
  account_id    integer NOT NULL REFERENCES accounts(id),
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL,
  created_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS account_ingest_tokens_account_idx ON account_ingest_tokens(account_id);

CREATE TABLE IF NOT EXISTS account_ingested_events (
  id           uuid PRIMARY KEY,
  account_id   integer NOT NULL REFERENCES accounts(id),
  source       text NOT NULL,
  kind         text NOT NULL,
  summary      text NOT NULL,
  occurred_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS account_ingested_events_account_source_idx ON account_ingested_events(account_id, source, occurred_at);

-- An account's own freely-named custom sub-agent — a finance agent, a marketing agent,
-- anything an account describes for itself — generalizing the fixed
-- claude-code/codex/gemini-cli ingest sources into an open-ended one. source_key is what
-- POST /api/ingest/:source matches once it isn't one of those three fixed names; it's
-- generated, not secret (the bearer token is still the entire auth boundary — this table
-- only decides which source_key values besides the fixed three are valid to push under,
-- and for which account). Personal/account-only by design: this never becomes a
-- SurfaceKey, is never in surfaces_catalog, and never feeds the claims/policy pipeline —
-- see personalConnectors.ts's accountCustomAgentProviders for why that boundary matters.
CREATE TABLE IF NOT EXISTS account_custom_agents (
  id            uuid PRIMARY KEY,
  account_id    integer NOT NULL REFERENCES accounts(id),
  source_key    text NOT NULL UNIQUE,
  name          text NOT NULL,
  purpose       text NOT NULL,
  created_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS account_custom_agents_account_idx ON account_custom_agents(account_id);

-- A personal account's own "Ask yourself" history — the counterpart to audit_log for
-- someone with no org (audit_log's org_id/target_person_id are NOT NULL, so it structurally
-- can't hold this). Deliberately not audit_log-shaped: no hash chain, no policy_revision_id,
-- none of the tamper-evident/disclosure properties CLAUDE.md rule 2 protects there — there
-- is no one else who could ever be shown this, so none of that machinery has anything to do.
-- Just your own chat history.
CREATE TABLE IF NOT EXISTS personal_asks (
  id                 uuid PRIMARY KEY,
  account_id         integer NOT NULL REFERENCES accounts(id),
  conversation_id    uuid NOT NULL,
  question           text NOT NULL,
  answer             text NOT NULL,
  created_at         timestamptz NOT NULL,
  -- Real tools the personal ask-bridge decided to call for this turn (e.g. ["Linear"]) —
  -- the personal counterpart to audit_log's snapshot.consultedSources, stored as its own
  -- column since there's no snapshot blob here. Null/empty for every turn asked before
  -- personal accounts could connect tools at all.
  consulted_sources  jsonb
);
CREATE INDEX IF NOT EXISTS personal_asks_account_idx ON personal_asks(account_id);
CREATE INDEX IF NOT EXISTS personal_asks_conversation_idx ON personal_asks(conversation_id);

/* ---------- personal OAuth connections ----------
   Not org data — credential state for the real-integration features under "Set up my
   agent" (the daily-summary feature). Plaintext tokens are fine for a single-user local
   dev tool; note this explicitly rather than pretend otherwise before this ever runs
   anywhere else. Fully owned by the person: unlike audit_log, mesh_app can update/delete
   its own connection state. */
CREATE TABLE IF NOT EXISTS person_oauth_tokens (
  person_id       integer NOT NULL REFERENCES people(id),
  provider        text NOT NULL,
  access_token    text NOT NULL,
  refresh_token   text,
  expires_at      timestamptz NOT NULL,
  connected_email text,
  -- Only Jira needs this so far (an API token is scoped to a specific Atlassian site,
  -- e.g. https://yourteam.atlassian.net — there's no discovery endpoint that derives it
  -- from the token alone). Null for every other provider.
  site_url        text,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (person_id, provider)
);

/* ---------- personal-account OAuth connections ----------
   Same shape as person_oauth_tokens above, one level up: an account with no organization
   has no `people` row to key off of at all (person_oauth_tokens.person_id is NOT NULL),
   so the 20-tool connector catalog needs its own account-keyed table to reach personal
   accounts — mirrors how account_main_agent mirrors org_main_agent and personal_asks
   mirrors audit_log, same "same shape, different owner" idiom throughout this schema. */
CREATE TABLE IF NOT EXISTS account_oauth_tokens (
  account_id      integer NOT NULL REFERENCES accounts(id),
  provider        text NOT NULL,
  access_token    text NOT NULL,
  refresh_token   text,
  expires_at      timestamptz NOT NULL,
  connected_email text,
  site_url        text,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (account_id, provider)
);

/* ---------- self-service tool connections ----------
   Real, general, user-driven — the alternative to reading a local session log off
   whatever machine the backend happens to run on. A person generates their own token
   here, pastes it into their own tool's hook/telemetry config (Claude Code, Codex CLI,
   Gemini CLI all support this natively — POST or OTLP export to an arbitrary URL with a
   bearer token), and their tool pushes real activity to /api/ingest/:source itself.
   docs/agent-to-agent-communication.md §13. */

CREATE TABLE IF NOT EXISTS ingest_tokens (
  id            uuid PRIMARY KEY,
  person_id     integer NOT NULL REFERENCES people(id),
  -- Only the hash is ever stored — the raw token is shown exactly once, at generation.
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL,
  created_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS ingest_tokens_person_idx ON ingest_tokens(person_id);

-- Raw pushed activity, one row per hook event. Deliberately separate from `claims`: this
-- is unprocessed input the ingestion pipeline aggregates into a claim, not itself
-- something respond() ever sees directly.
CREATE TABLE IF NOT EXISTS ingested_events (
  id           uuid PRIMARY KEY,
  person_id    integer NOT NULL REFERENCES people(id),
  source       text NOT NULL,
  kind         text NOT NULL,
  summary      text NOT NULL,
  occurred_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ingested_events_person_source_idx ON ingested_events(person_id, source, occurred_at);

/* ---------- invitations ----------
   Release audit SEC-08: adding someone by email used to link the chart entry (or grant the
   admin role) to whichever account already held that email — so anyone who signed up early
   with a future employee's address became that employee. Now an email only ever creates an
   invitation; the chart entry or role is bound when a logged-in account whose email matches
   presents the one-time token. Only its SHA-256 hash is stored, same as ingest tokens. */
CREATE TABLE IF NOT EXISTS invitations (
  id           uuid PRIMARY KEY,
  org_id       integer NOT NULL REFERENCES organizations(id),
  email        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('person', 'admin')),
  person_id    integer REFERENCES people(id) ON DELETE CASCADE,
  admin_role   text CHECK (admin_role IN ('owner', 'admin', 'viewer')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   integer NOT NULL REFERENCES accounts(id),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  emailed_at   timestamptz,
  accepted_at  timestamptz,
  accepted_by  integer REFERENCES accounts(id),
  revoked_at   timestamptz,
  CHECK ((kind = 'person' AND person_id IS NOT NULL) OR (kind = 'admin' AND admin_role IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS invitations_org_idx ON invitations(org_id);

/* ---------- grants ---------- */

-- Platform tables: the app reads accounts/organizations and can create orgs, but
-- never renames or deletes one from here. accounts gets INSERT (signup, invites) and
-- UPDATE (setting/changing a password) — still no DELETE.
GRANT SELECT, INSERT, UPDATE ON accounts TO mesh_app;
GRANT USAGE ON SEQUENCE accounts_id_seq TO mesh_app;
GRANT SELECT, INSERT ON organizations TO mesh_app;
GRANT USAGE ON SEQUENCE organizations_id_seq TO mesh_app;

-- RBAC membership: full self-service lifecycle (invite, promote/demote, remove).
GRANT SELECT, INSERT, UPDATE, DELETE ON org_admins TO mesh_app;

-- Sessions: created at login, looked up at every authenticated request, revoked (not
-- deleted — revoked_at, matching ingest_tokens' pattern) at logout.
GRANT SELECT, INSERT, UPDATE ON sessions TO mesh_app;

-- Reference / catalog data: read-only to the app.
GRANT SELECT ON surfaces_catalog, never_ingested, runtime_catalog TO mesh_app;

-- Roster: the app builds the org chart (add/remove people) and narrows surfaces.
GRANT SELECT, INSERT, UPDATE, DELETE ON people TO mesh_app;
GRANT USAGE ON SEQUENCE people_id_seq TO mesh_app;

-- Escalations, claims, and evidence can all now be authored by real detection/ingestion
-- (docs/escalation-triage.md, Claude Code session activity) — INSERT/UPDATE for an
-- idempotent upsert, never DELETE. An escalation, once raised, stays in history even after
-- resolved — acknowledge/resolve set status + actor + timestamp, they never remove a row.
GRANT SELECT, INSERT, UPDATE ON escalations TO mesh_app;
GRANT SELECT, INSERT, UPDATE ON evidence TO mesh_app;
GRANT SELECT, INSERT, UPDATE ON claims TO mesh_app;

-- Runtime registrations: full self-service lifecycle.
GRANT SELECT, INSERT, UPDATE, DELETE ON person_runtimes TO mesh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_runtimes TO mesh_app;

-- The org's one main agent: admin-set, admin-changeable, never deleted outright (only
-- ever replaced by setting a new one — UPDATE covers that via ON CONFLICT DO UPDATE).
GRANT SELECT, INSERT, UPDATE ON org_main_agent TO mesh_app;

-- The personal counterpart: same shape, same reasoning, self-set instead of admin-set.
GRANT SELECT, INSERT, UPDATE ON account_main_agent TO mesh_app;

-- A personal account's own chat history — fully owned by the account, not append-only
-- like audit_log (no disclosure/tamper-evidence property applies to your own private
-- chat with yourself).
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_asks TO mesh_app;

-- Personal OAuth connections: fully owned by the person, not append-only like audit_log.
GRANT SELECT, INSERT, UPDATE, DELETE ON person_oauth_tokens TO mesh_app;

-- Same for the account-keyed counterpart (personal, no-org connector connections).
GRANT SELECT, INSERT, UPDATE, DELETE ON account_oauth_tokens TO mesh_app;

-- Ingest tokens: the app creates and revokes them (revoked_at, not DELETE — a used-then-
-- revoked token stays visible in its own history). Events are insert-only: a pushed
-- observation is never edited or removed after the fact.
GRANT SELECT, INSERT, UPDATE ON ingest_tokens TO mesh_app;
GRANT SELECT, INSERT ON ingested_events TO mesh_app;
GRANT SELECT, INSERT, UPDATE ON account_ingest_tokens TO mesh_app;
GRANT SELECT, INSERT ON account_ingested_events TO mesh_app;
-- Custom agents: registered and removed by the account itself, never edited in place.
GRANT SELECT, INSERT, DELETE ON account_custom_agents TO mesh_app;

-- Invitations: created, accepted and revoked by stamping columns — never deleted by the app
-- (a person's removal cascades their pending invitation away at the schema level).
GRANT SELECT, INSERT, UPDATE ON invitations TO mesh_app;

-- Policy revisions: append a new row, never touch an old one.
GRANT SELECT, INSERT ON policy_revisions TO mesh_app;
GRANT USAGE ON SEQUENCE policy_revisions_id_seq TO mesh_app;
REVOKE UPDATE, DELETE ON policy_revisions FROM mesh_app;

-- Audit log: append-only, structurally. No UPDATE or DELETE grant exists to revoke —
-- the point is that mesh_app was never given them, not that they were taken away.
GRANT SELECT, INSERT ON audit_log TO mesh_app;
REVOKE UPDATE, DELETE ON audit_log FROM mesh_app;
