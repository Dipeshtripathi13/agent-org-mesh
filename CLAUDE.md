# Eternity Nest — working notes for Claude Code

**The product's name lives in one place per package: `frontend/src/lib/brand.ts` and
`backend/src/brand.ts` (`PRODUCT_NAME`, plus `PRODUCT_SLUG` for machine-readable ids).** Renamed
from "Agent Org Mesh" to "Eternity Nest" on 2026-09-17 — the company and the product are the same
name. Every screen, the browser tab (set from the constant in `main.tsx`), the legal pages and the
invitation/verification/reset emails read it from there. Deliberately not renamed: the applied
baseline migration's comment (migrations are checksum-verified; never edit one), the docker-compose
volume name (renaming it orphans local database data), and the seeded dev logins
(`…@agentorgmesh.local`, referenced across the API test suites). The marketing site keeps its own
copy in its own repo.

## What this is
A coordination layer. Every organization has one aggregator agent — set once, org-wide, by
an org admin — that reads working context from connected systems on behalf of everyone in
the chart. Agents answer questions across and up the org chart so humans stop relaying
status manually. **Read-only: it never writes to any connected system.**

The org's one aggregator can be Claude, ChatGPT, or a self-hosted/open-source model
(Ollama, vLLM, ...) — resolved per-organization from its real main-agent registration
(`backend/src/integrations/runtimeProvider.ts`'s `getMainProvider(orgId)`,
`org_main_agent` in the schema), never hardcoded to one vendor. Only an org admin can set
or change it (`POST /api/organizations/:orgId/main-agent`, `requireOrgRole` 'admin');
every person's own "Set up my agent" shows it read-only. See "Where to go next" for what's
live-verified.

Multi-tenant: an organization can have several real admins with different permission
levels (`Admin → Organizations`, the "admins" panel — owner/admin/viewer, see the auth
rule below), and one real account (a human, not a role — see the auth rule) can
administer several organizations *and* be a person in several organizations at once —
two independent facts about the same login, not two account types. Signing up
(`/auth/signup`, "New here?" on the login screen) creates a personal account and a
one-person "workspace" org for it in the same step — no company name to type, no separate
admin action required just to start using the product (see the signup/step-up-auth
paragraph below for the two other shapes this went through before landing here). No
existing admin has to set anything up for you first. Everything an org actually
contains — people, claims, evidence, escalations, policy revisions, audit entries, runtime
registrations — carries an `org_id` and is isolated per org. The connector/runtime
catalogs (`surfaces_catalog`, `never_ingested`, `runtime_catalog`) are global platform
product surface, shared by every org.

## Rules that are not negotiable

1. **The policy engine is deterministic code, never a prompt.**
   `backend/src/domain/policy.ts`. No LLM, no randomness, no clock reads. Same inputs,
   same output, always. If you change it, the golden tests must be updated deliberately —
   never loosened to make a failure go away.

2. **The audit log is append-only and snapshotted.**
   `backend/src/domain/audit.ts` exports exactly one mutator: `append` (used by the golden
   tests against an in-memory log). The running server instead goes through
   `backend/src/db/repo.ts`'s `appendAuditEntry`, backed by Postgres — but it hashes rows
   with the exact same `hashEntry`/`verifyChain` functions, so the two never diverge. The
   database enforces the guarantee structurally: the `mesh_app` role has INSERT and SELECT
   on `audit_log` and nothing else — no UPDATE/DELETE grant was ever issued, so there is
   nothing to bypass from application code. Responses are resolved once and stored whole.
   Never re-derive a stored answer from current policy — that lets a later edit rewrite
   history, and it is the bug this codebase exists to avoid.

3. **Policies are immutable revisions.**
   Editing writes a new `PolicyRevision`. Nothing updates in place. Every snapshot records
   the revision in force when it was served. `policy_revisions` gets the same INSERT-only
   grant as `audit_log`.

4. **Excluded classes are enforced at the connector layer, not by prompt.**
   Workday, Ironclad, benefits, and DMs are never registered as connectors. There is no
   flag that turns them on. `CANT` means structurally absent; `WONT` means policy declined.
   Never conflate them in code or in copy.

5. **Withholding is always visible.** No code path silently drops a claim from a response.

6. **No number on the Overview screen is a literal.** If it can't be derived from state,
   it doesn't belong there.

7. **Who is acting comes only from the session cookie — never from the request.** One
   identity table, `accounts` (`backend/src/domain/auth.ts`, `db/repo.ts`). The same
   account can hold `org_admins` rows and/or be linked from `people` rows via
   `people.account_id` (one org-chart identity per org). Every request that acts as an
   org-chart person resolves that person with `server.ts`'s `requireSessionPerson(req,
   orgId)` (the session's own identity in that org) or `requireSelf(req, id)` (that
   identity must be exactly `:id`). There is no `requesterId`/`actorPersonId` in any
   request body, no anonymous fallback, and no "accountless demo person" branch — a person
   with no linked login has no self-service at all until an admin adds their email. The
   release audit (2026-09-12, SEC-01/02/05) confirmed live that the old fallback let an
   anonymous caller ask as the CEO about anyone, preview anyone at Executive tier by typing
   the same id twice, and push fabricated activity into anyone's claims. Do not
   reintroduce a client-asserted identity for convenience, testing, or a demo — local dev
   uses the seeded logins (`marta@`/`hana@`/`diego@agentorgmesh.local`).

## Layout
```
backend/src/domain/   types, coverage, policy, audit, auth   ← the correctness core (pure,
                       sync, no DB — this is what the golden tests exercise). auth.ts is
                       password hashing (scrypt) + session-token hashing (SHA-256) for
                       real admin login — no new dependency, Node's own crypto module.
backend/src/data/     seed.ts — 40-person org, claims, evidence (source of truth the DB
                       seed script loads from; also what the golden tests import directly)
backend/src/db/       pool.ts (pg.Pool), repo.ts (Postgres-backed reads/writes the server
                       actually uses — accounts, organizations, people/claims/etc, all
                       org-scoped except the global catalogs and `accounts` itself).
                       `createOrganization` is the one place an org actually gets created
                       — atomically makes the caller both its owner-admin and its first
                       person (Owner, top of the chart), whether that's a brand-new
                       individual's very first org or an existing admin adding another.
backend/db/migrations/ numbered SQL migrations — 0001_baseline.sql is the full schema, the mesh_app
                       role and its grants. Applied in order by src/db/migrations.ts (recorded in
                       schema_migrations); never edit one once applied — add the next number.
backend/scripts/       migrate.ts, seed-db.ts — run against DATABASE_ADMIN_URL
backend/src/server.ts Fastify API — composes domain/ functions over repo.ts data
backend/src/integrations/modelProvider.ts, runtimeProvider.ts  the model-agnostic dispatch
                       layer — one ModelProvider interface, resolved per-organization from
                       its real, admin-set main-agent registration (anthropic.ts /
                       openaiCompatible.ts — the latter also covers self-hosted/local
                       models via OPENAI_BASE_URL, no per-vendor branching anywhere else)
frontend/src/lib/conversations.ts  pure logic behind multi-chat on both MyAgent.tsx
                       ("Ask yourself") and Ask.tsx (cross-person) — real, switchable chat
                       history reconstructed from the audit log, with genuine cross-turn
                       context for follow-up questions
frontend/src/lib/OrgContext.tsx  React context for the Admin panel's "current org" —
                       every Admin screen reads orgId from here. Re-fetches the org list
                       whenever the logged-in account changes (login populates real orgs,
                       logout clears back to none).
frontend/src/lib/AuthContext.tsx  React context for real login — session cookie, not a
                       client-asserted id; exposes `account`, `orgRoles` (this account's
                       owner/admin/viewer role per org id it administers), `people` (this
                       account's own org-chart identities, one per org it's a member of),
                       `login`/`signUp`/`logout`, `adminElevatedUntil` (this session's
                       step-up state — see the main-agent/step-up-auth paragraph below).
                       `Shell` in App.tsx renders `pages/Login.tsx` (which itself can hand
                       off to `pages/SignUp.tsx`) in place of *either* panel's content
                       whenever there's no session — both "My agent" and Admin require a
                       real login now; step-up is action-scoped within Admin, not a gate on
                       entering it (see the main-agent/step-up-auth paragraph below).
frontend/src/lib/MeContext.tsx  React context for the My-agent panel's "who am I" — no
                       longer a free identity switcher. It used to let any logged-in
                       account browse into *any* organization (a standing public demo org,
                       always, plus any real one it happened to administer) and pick *any*
                       person there, viewing that person's own full self-view as if it were
                       the account's own — reasonable while this was a closed dev/QA build,
                       reported live as exactly the alarming thing it was once real
                       strangers could sign up ("why am I able to see this organization...
                       I am able to sign in as other person"). Now resolves *only* from
                       AuthContext's own `people` — the account's real, linked org-chart
                       identities, nothing else — synchronously every render rather than
                       via an effect, so there's never a render where `identities` has
                       arrived but the active one hasn't caught up yet (a real bug found
                       immediately after the rewrite: that one-render lag let a `0`
                       sentinel id leak into a real request right after signup). The org
                       picker only renders at all for genuine multi-org membership (two or
                       more real identities); there's no person-picker anymore, since
                       within one org you only ever have exactly one identity — yourself.
                       Genuinely previewing another role or person is still real, still
                       supported, still clearly labeled as a simulation rather than a
                       login: `pages/Preview.tsx` and Admin's `pages/PolicyMatrix.tsx`,
                       both via `/api/query`'s persist:false preview mode.
frontend/src/pages/OrgSetup.tsx  Admin → Organizations: create an *additional* org (a
                       brand-new individual's first org gets created automatically by
                       signup itself now, see below) — build its chart person by person,
                       optionally with an email that resolve-or-creates a real login for
                       that person, the same one-time-temp-password pattern as inviting an
                       org admin (and ingest tokens before that) — and manage which real
                       accounts (owner/admin/viewer) administer it.
frontend/src/pages/SignUp.tsx  Personal account fields only (name/email/password) — the
                       one-person org it also creates is automatic, not asked for here.
                       For the now-rare case of a real account connected to no org at all,
                       `MyAgent.tsx`/`SetUpMyAgent.tsx` branch into a personal mode
                       in-place (see the personal-main-agent paragraph below) rather than
                       a separate fallback page — there's no more `NoOrganizationYet.tsx`.
frontend/src/         React + Vite, no CSS framework
docker-compose.yml    Postgres 16, host port 5433 (5432 was already taken locally)
```

## Commands
```
docker compose up -d --wait          # or: cd backend && npm run db:up
cd backend  && npm run db:migrate    # DEV/TEST RESET: drop the schema, then apply every migration
cd backend  && npm run db:migrate:up # apply only pending migrations (what every deploy runs first)
cd backend  && npm run db:seed       # load the seed.ts dataset into Postgres
cd backend  && npm run dev           # API on :3001, reads DATABASE_URL (defaults to
                                      #   the mesh_app role against the compose db)
cd frontend && npm run dev           # UI on :5173, proxies /api
cd backend  && npm test              # 215 golden tests — pure in-memory, no DB required
cd backend  && npm run test:api      # route × caller authorization table (src/authz.api.test.ts)
                                      #   via app.inject() against agent_org_mesh_test, which it
                                      #   creates, resets and seeds each run (refuses any DB name
                                      #   not ending in _test). Needs the compose Postgres up. Run
                                      #   it after touching any route's auth — it is the regression
                                      #   guard for release-audit SEC-01..07/09/13.
cd frontend && npm test              # 32 tests for pure lib/ logic — deriveAllowedRoles'
                                      #   client-side mirror, escalation status text,
                                      #   Ask-yourself chat-history reconstruction
cd backend  && npm run check:connectors  # are every connector's real read endpoints still
                                      #   there? run it from the deployed container, not
                                      #   here — see the Jira/Notion verification note
```
Both `mesh_admin` (schema owner, used only by migrate/seed) and `mesh_app` (least-privilege
runtime role) credentials default to the values in `backend/db/migrations/0001_baseline.sql` /
`docker-compose.yml`; override via `backend/.env` (see `.env.example`) for anything else.

`npm run db:seed` creates dev logins, all with password `admin-dev-only`:
`jordan@agentorgmesh.local` (owner-admin of the seeded Northbeam org, not in its chart) and
`marta@` (CEO), `hana@` (manager), `diego@` (engineer) — linked to seeded people, since every
request now acts as the session's own identity (rule 7). The script refuses to run with
`NODE_ENV=production`, and refuses any database holding an org other than Northbeam unless
`CONFIRM_RESET=yes`: it TRUNCATEs every account and org. The login page shows these
credentials only in a Vite dev build. (Release audit SEC-06, 2026-09-12: production had been
seeded, with the published Jordan password working live — the demo org and account were
deleted from production that day.) To try self-serve signup instead, use
"New here? Create your account" on the login screen with any new email — you land in your
own real, one-person org immediately, no separate org-creation step.

**Asking the same question about several freely-chosen people at once, and getting one
rolled-up update — `POST /api/agent/ask-multi`, the multi-target sibling of
`/api/agent/ask`.** Requested directly, as the concrete first instance of the product's
real stated purpose (see the top of this file): one main agent routing a question out to
several other people's own agents and rolling the results into one answer, rather than
asking about each of them one at a time. Went through one real design correction before
landing here: the first version derived the target set structurally from the org chart
(a manager's own direct reports only, `people.filter(p => p.managerId === requesterId)`,
mirroring `deriveAllowedRoles`'s `'Direct manager'` check run in reverse) — reworked
immediately, pushed back on directly, once it was clear the real scenario is broader than
direct reports: a CEO asking the Eng manager and the Fin manager about the same thing in
one go, two people who don't report to each other or necessarily to the asker directly.
`targetIds` is therefore a real, client-supplied, open selection now, same as a single
`/api/agent/ask`'s one `targetId` always has been — the trust boundary that actually
matters didn't move for that: one claimed `role` (same six roles the single-target Ask
page already offers) is checked per target via `deriveAllowedRoles`, independently, and a
target the role isn't truthful for is never silently dropped — it comes back as its own
explicit, visible rejection (`{ ok: false, reason }`) in `perPerson`, the same
"withholding is always visible" rule (rule 5) the rest of this system already follows for
everything else. Every target that *does* pass still gets its own real `gatherAll` →
`respond()` call under the claimed role and its own real audit row — asking about several
people is that many real disclosure events, not one, and each of them still sees exactly
and only what was told about them, never another selected person's data folded in. The
one combined answer is built a second time, from each accepted target's own
already-synthesized (or raw-fallback) answer plus the rejected targets' own honest
rejection reasons — never from raw claim sentences a second time — and isn't persisted
anywhere on its own, since audit rows are `(requester, target)` pairs by schema and each
accepted target's own row above already carries the real record. Reuses
`ModelProvider.synthesize()` completely unchanged, called once per accepted target plus
once more for the rollup — no interface change needed in `modelProvider.ts`/`anthropic.ts`/
`openaiCompatible.ts`. Frontend: an "Ask several people" panel on `Ask.tsx` below the
existing single-target thread — a role-chip row (unfiltered, since truthfulness is now
per-target rather than per-one-fixed-target) plus a person-chip multi-select over everyone
but yourself, with its own small per-person expandable breakdown that distinguishes
accepted answers from visible rejections. Deliberately not folded into the single-target
chat thread above it: there's no per-selection conversation-history endpoint, so this
stays its own small, stateless panel rather than pretending to be a chat. Live-verified
against the running dev API and the real seeded Northbeam org, not just typechecked: asked
as a real executive (Marta Vieira, `managerId: null`) about two people from different,
deep subtrees under role `'Executive'` and got back a real combined answer plus two real
per-person entries; separately, asked as a real direct manager (Hana Oyelaran) under role
`'Direct manager'` about one real report, one unrelated person, and one nonexistent id in
the same call, and confirmed the real report was accepted while the other two came back as
honest, specific rejections (`"that relationship doesn't hold in the org chart"` /
`"not found in this org chart"`) rather than being silently dropped or failing the whole
request; confirmed real audit rows landed under each requester's own id and claimed role.

**Sub-agent registration generalizes beyond coding tools — an account can register its own
freely-named custom agent (a finance agent, a marketing agent, anything) and have it
consulted by its personal main agent, the same way Claude Code/Codex CLI/Gemini CLI
already are.** Requested directly, as the concrete next step of the product's real stated
purpose (see the top of this file): the fixed three ingest sources were coding-specific
stand-ins for a much bigger idea — any AI agent, in any domain, that a person's own main
agent can consult as a tool. Deliberately scoped to the account (personal) side only, not
org mode: extending this to org-visible claims would mean opening `SurfaceKey` — a closed
union `surfaces_catalog`, `coverage.ts`, and `policy.ts` all depend on being a known,
governed set with real `dataClass`/`tier` implications — to arbitrary user-typed names,
which is a real disclosure-governance question this pass deliberately didn't reopen. The
personal/account side has no such boundary to cross (a personal ask has no claims table,
same reasoning `personalConnectors.ts`'s own module comment already gives for GitHub/Jira
there), so this is where an open-ended "register anything" mechanism can exist safely.
`account_custom_agents` (schema.sql) is a small new table — `source_key` (generated,
not secret; the ingest token is still the entire auth boundary), `name`, `purpose` — with
`POST/GET/DELETE /api/accounts/me/custom-agents`. Registering doesn't mint a new secret:
it reuses the exact same account-wide ingest tokens `POST /api/accounts/me/ingest-tokens`
already generates for Claude Code/Codex CLI/Gemini CLI (one token authenticates a push to
any of a person's sources — this was already true before this change). `POST
/api/ingest/:source`'s fixed `INGEST_SOURCES` whitelist gained one more valid case: a
`source` that isn't one of the three fixed names is now also accepted if it resolves to a
real `account_custom_agents` row owned by *this* resolved token's account — checked by
identity, not just "does this string look like a real source," so one account can never
push under another's registered agent name. `eventIngestion.ts` needed zero changes to
support this — its `normalizeIngestPayload`/`formatIngestedEventsDigest` were already
fully generic (`{kind, summary, occurredAt}`, a plain bullet-list digest), coding-specific
only in the fixed three source names layered on top, never in the payload shape itself.
`personalConnectors.ts`'s new `accountCustomAgentProviders(accountId)` is the dynamic
counterpart to the module's static `ACCOUNT_DIGEST_PROVIDERS` array — rebuilt fresh from
`account_custom_agents` on every ask rather than a module-level constant, since the whole
point is a person adds these without a code change — and "connected" means the same thing
it does for codex/gemini-cli: at least one real event has actually been pushed, not just
registered. `POST /api/agent/ask-personal` merges its output into the exact same
router/gather/fallback pipeline every other connected source already goes through
(`selectRelevantSurfaces`, per-surface `sinceDays`, the honest-empty and honest-error
fallback text), not a parallel code path — a custom agent is indistinguishable from any
other consulted source once it reaches the router. Frontend: `ConnectorsPanel.tsx` (used
for both a true personal account and an org member's own personal agent — `owner: {kind:
'account'}` either way) gained a "Custom agents" entry in the existing "Connect a tool"
dropdown ("+ Register a new custom agent…"), a name/purpose registration form, and a manage
panel per registered agent reusing the same token list/generate/revoke UI the three fixed
ingest-token tools already have, with a generic curl-based push example (no tool-specific
hook format exists for an arbitrary custom agent the way Claude Code's PostToolUse hook or
Codex's otel config do). Live-verified end-to-end against the running dev API, a real
Postgres row, and a real local Ollama model answering — not just typechecked: registered a
"Finance Agent" (purpose: "Tracks AP/AR status and monthly close") on a real account,
pushed one real event through its generated `source_key`, and a real `ask-personal` call
("What has my finance agent been doing lately?") had its own router genuinely select
"Finance Agent" as relevant and answer from the real pushed content — `consultedSources`
confirmed it, not just the answer text; confirmed a foreign/unregistered source is rejected
with the same honest error whether it's a typo or someone else's agent name; confirmed
deleting the agent immediately revokes its `source_key`, and a push against it afterward
gets the same clean rejection as a name that was never registered. The additive
`account_custom_agents` table needs the same by-hand production migration every new table
does against a live database — `backend/scripts/migrate-add-account-custom-agents.ts`,
same pattern as `migrate-add-must-change-password.ts` — since `schema.sql` itself is a full
`DROP SCHEMA ... CASCADE` reset, never something to run against real data.

**A real, on-demand "Verify" check closes a gap this project had lived with since the
Jira 410 incident: every connector's own status check has only ever meant "a credential is
stored," never "it still works."** Found by re-reading this file's own connector-catalog
paragraph after a round of market research (`docs/published/` — enterprise buyers now cite
observability as the #1 reason agent pilots die, 88% never reaching production) landed on
the same conclusion from the outside: `get<Tool>Status`/`getGenericConnectionStatus`
everywhere in this codebase is a bare `{ connected: !!row }` DB read, no live call, for
every one of the ~15 PAT/OAuth-style connectors. That's precisely why Jira's connector
passed every prior check for months while Atlassian had already removed the endpoint
underneath it — an invalid credential and a deleted endpoint both fail differently, but a
DB-existence check can't see either one. `POST /api/person/:id/connectors/:key/verify` and
`POST /api/accounts/me/connectors/:key/verify` (`verifyProvider` in `resourceProviders.ts`,
`verifyAccountProvider` in `personalConnectors.ts`) fix this the cheapest way available:
reuse each connector's own already-built `ingest`/`fetchDigest` function unchanged, called
with `since = right now` — the exact same real API request that ingestion always makes, just
against a window narrow enough to almost never match anything new. A working credential
resolves; a revoked one, a deprecated endpoint, or a real outage throws, and that thrown
message is the honest signal surfaced back — no new per-connector code needed for any of
the ~15 tools this covers. Deliberately excludes the three ingest-token tools (Claude
Code/Codex CLI/Gemini CLI) and custom agents: none of them have a live external credential
that can go stale the way a PAT/OAuth token can — their own "connected" status (has a real
event ever landed) already is their honest liveness signal, so a "Verify" button for them
would just be confusing, not more true. Frontend: a "Verify" button next to "Manage" on
every eligible connected tool in `ConnectorsPanel.tsx` (gated on `authType !== 'ingest-token'`,
shared by both person and account owners), showing the real result inline — "✓ Verified
just now" or the actual failure message — rather than a script someone has to remember to
run from a deployed container. Live-verified against the running dev API, not just
typechecked: a genuinely not-connected tool reports "not connected" cleanly; an unsupported
key reports "no live check available for this tool" cleanly; and — the real proof — a
person's Linear connection was given a deliberately invalid stored token directly in the
database (surface manually flipped to `'connected'`, exactly reproducing what a silently
revoked credential looks like) and the verify call reached Linear's real API and came back
with a genuine `invalid_token: Invalid access token` rejection, not a generic error — the
exact class of failure the old status check could never have surfaced.

**Trello moves from 'connectable' to genuinely 'live' — the first of the five tools
(Trello/Airtable/Monday/Figma/Discord) whose connect flow worked but never actually read
anything.** Picked deliberately as one tool done thoroughly rather than five done
shallowly, following this project's own established convention (the MCP rollout's own
CLAUDE.md paragraph makes the same call explicitly) — Airtable/Monday/Figma/Discord stay
exactly where they were, still real, still deferred. `getRecentTrelloActivity` reads
`GET /1/members/me/actions` — Trello's own real per-member activity feed, one of the few
connectors in this codebase confirmed against a fully-documented official response shape
rather than a best guess (`{ type, date, data: { card: { name }, board: { name } } }`),
filtered to five narrative action types (card created/updated/commented/moved/assigned)
the same way `eventIngestion.ts`'s `NARRATIVE_TOOLS` narrows Claude Code's own hook
events — a raw actions feed is mostly board-administration noise nobody asks about.
Trello's own stored credential is a `apiKey:token` pair, not a single bearer token (its
real auth model), so it reuses the generic connection's one `access_token` column by
concatenating the two at save time (`trello.ts`, already true before this pass) and
splitting them back apart on read (`getTrelloConnection`/`getTrelloAccountConnection`, new
this pass) — neither value can contain a colon, so a plain split is safe. Wired into both
`resourceProviders.ts`'s `PROVIDERS` (org-mode claims) and `personalConnectors.ts`'s
`ACCOUNT_DIGEST_PROVIDERS` (personal ask-personal bridge) — the same two registries every
other connector here already goes through, so Trello needed zero new plumbing in either
`server.ts` or the frontend: `ConnectorsPanel.tsx`'s "reads at ask-time" label is already
driven by `connectorCatalog.ts`'s own `status` field, so flipping one entry from
`'connectable'` to `'live'` was the only catalog change needed. Live-verified two ways, the
same bar every UNVERIFIED-with-a-real-account connector here uses: a deliberately invalid
key/token pair reaches Trello's real API directly and gets a genuine `401 invalid key`,
not a malformed-request error; and the exact same rejection was reproduced end-to-end
through this app's own new "Verify" check (both the person- and account-keyed paths),
confirming the whole pipeline — connection storage, credential-splitting, the real fetch,
and the error surfaced back to the caller — works together, not just each piece in
isolation. A real successful connect-then-ask round trip remains unverified for the same
honest reason every other new connector in this project does; update this note once a real
Trello account is available.

## Where to go next
- **Switch on the reliability settings only the operator can.** (1) In Railway, enable "Wait for
  CI" on the service so a red GitHub Actions run on `prod` never deploys. (2) In GitHub, protect
  `main`/`prod` so CI must pass before merging. (3) For Sentry, create a Node project and set
  `SENTRY_DSN` (optionally `SENTRY_ENVIRONMENT`) on Railway — nothing else is needed; confirm a
  test error appears, then note it here.
- **Never trust a Railway-side redeploy until the deploy source is fixed.** On 2026-09-12,
  adding `RESEND_API_KEY`/`EMAIL_FROM` on Railway triggered an automatic redeploy that rebuilt
  production from **pre-audit code** (the remote `prod`, `qa` and `dev` branches were still at
  `7f798ab`, 2026-08-25, 60 commits behind `main`). For ~15 minutes anonymous callers could
  read rosters and disclosure history again, and connectors couldn't decrypt their tokens. It
  was caught by re-probing production after the variable change and restored with
  `railway up` from `main`. After *any* Railway variable change, restart or redeploy, re-run
  the anonymous probes (an unknown `/api/invitations/aoi_…` token must return "this invitation
  link is not valid"; `/api/org?orgId=…` must return 401) and confirm the deployed commit. Same day, `prod`, `qa` and `dev` were fast-forwarded to
  `main` — pushing `prod` immediately triggered a Railway build, confirming the service
  deploys from the `prod` branch. Keep those branches moving with `main` (or repoint the
  Railway service at `main`) so they never drift behind the security fixes again.
- **Email is configured on production** (Resend, sender `noreply@contact.eternitynest.com`,
  verified domain) — see `integrations/resendEmail.ts`'s module comment for exactly what was
  verified. Unblocked by it: mandatory email verification at signup, and the emailed
  self-service password reset (which also closes the invitation-blocking trade-off in the
  SEC-08 paragraph). The Resend key was pasted into a chat session on 2026-09-12; rotate it
  in Resend and update Railway.
- **Legal pages — status 2026-09-12.** Filled in from the operator: operated by "Eternity Nest"
  (not yet a registered legal entity — update the pages once it is), contact
  `privacy@eternitynest.com`, governed by US law, hosting region United States (Virginia,
  Railway `us-east4`, read from the running container), free during the beta, and a US$100 /
  12-months liability cap as a placeholder default. Pushed tool activity is deleted after 90 days,
  and that is enforced, not just stated: migration `0002_activity_retention` grants the app role
  DELETE on `ingested_events`/`account_ingested_events` only, and `src/db/retention.ts` purges
  older rows a minute after start and every 6 hours (`retention.api.test.ts`). `privacy@eternitynest.com` now receives
  mail (2026-09-13: ImprovMX forwarding to the operator's Gmail — MX `mx1/mx2.improvmx.com` and
  SPF on the root domain; Resend's records under `contact.` are separate and must not be
  touched; a test sent from production arrived). The filled-in `Legal.tsx` is parked in
  `git stash` ("legal pages: Eternity Nest details…") while the legal work is on hold — restore
  it with `git stash pop`. **Still blocking publication:** the US **state** for governing law;
  the effective date (set on publish); counsel review of the whole text, including the
  region-specific rights section; then set `isDraft: false`.
- **Complete the legal pages, then deploy them.** `frontend/src/pages/Legal.tsx` (public
  `/legal/privacy`, `/legal/terms`, `/legal/subprocessors`, linked from sign-in and the
  signup consent line) was drafted 2026-09-12 from what the code actually does. Every fact
  only the operator can supply — legal name, contact, postal address, governing law,
  liability cap, hosting region, event retention, effective date — is in the `LEGAL`
  constant at the top of that file and renders as a visible bracketed placeholder under a
  draft banner. Fill those, have counsel review (including the region-specific rights
  section), set `isDraft: false`, then deploy. Keep the text true to the code — e.g. the Security
  section's claim that tool credentials are encrypted at rest became true with SEC-10
  (`domain/credentials.ts`, 2026-09-12); re-check claims like that whenever storage changes. The release audit's remaining work is Gate 1 onward
  (https://claude.ai/code/artifact/1e5b426a-b54e-405b-8b45-03fec727c72f).
- **Extend session-trust to the remaining self-service connection endpoints.** **Done
  2026-09-12 (release audit SEC-01–05) — superseded, kept for history:** every endpoint now
  resolves identity from the session only (rule 7), and `/api/org`, `/api/policy`,
  `/api/audit/subject/:id`, `/api/person/:id/runtimes`, and `/api/organizations/:id/main-agent`
  are session-gated to org members/admins. Do not act on the reasoning below. Rule 7 is
  now mostly closed, not mostly open — updated after a full security audit fixed the
  worst of it. `POST /api/agent/ask` and `POST /api/query`'s `requesterId`, escalation
  acknowledge/resolve's `actorPersonId`, and `/api/agent/conversations`'s `requesterId`
  all now prefer the logged-in session's own linked person-identity over a client-asserted
  one (`sessionPreferredPersonId` in `server.ts`) — this is exactly the piece that used to
  let anyone spoof "who's asking about whom," and it's fixed everywhere that actually
  gates disclosure. What's left is narrower and lower-stakes: GitHub/Jira/Gmail connect,
  ingest tokens, sub-agent registration, claim correction, and the generic connector
  endpoints all still use the more permissive `requireSelfIfLoggedIn` — open when a real
  session exists but has no linked identity in *this* id's org, and fails closed on a
  genuine mismatch (a real, linked session trying to touch a different real person's own
  connections). **Considered, and deliberately not done: mirroring `sessionPreferredPersonId`'s
  substitute-rather-than-block pattern here.** That pattern fits *attribution* endpoints
  (who's asking, for a disclosure decision) — silently trusting the session over a claim is
  strictly safer there. These are *target* endpoints (which person's own connection record
  gets written), where silently redirecting a mismatched request to the caller's own
  identity instead of erroring would be a worse UX than today's explicit 403 for no real
  security gain (the mismatch was already blocked either way) — reconsidered after reading
  this note literally and worth recording so it isn't re-attempted without new reasoning.
  What *was* a real, narrowly-scoped gap and is now fixed: the "no session at all" branch
  used to stay open unconditionally, regardless of whether `id` itself belonged to a real,
  loggable-into account — meaning a totally anonymous caller could connect a fake token to
  *any* real person's profile, not just the accountless seeded ones the openness was meant
  for. `requireSelfIfLoggedIn` now checks `person.accountId` in that branch: still fully
  open for the genuine demo affordance (a seeded person with no login of their own —
  confirmed unchanged live, an anonymous connect against one of them still reaches Linear's
  real API), now closed for anyone with a real, linked account (confirmed live: an
  anonymous connect against a person freshly linked to a real account now gets a clean 403,
  "log in to manage this person's connections", instead of silently succeeding). "My agent" went through
  two rounds of tightening after this audit, both found live rather than anticipated in
  design. First: its identity switcher (`MeContext.tsx`) *used to* stay open regardless of
  login as a documented demo affordance — no longer, once the marketing site's real "Try
  it for free" link could send actual strangers here and an anonymous visitor defaulting
  into a named seeded person's data read exactly like a broken login, not a demo; `App.tsx`'s
  `Shell` now requires a real login before rendering either panel's content (see the
  step-up-auth paragraph below). Second, reported by a real user testing the live product
  right after that shipped: even *logged in*, the same switcher still let any account
  browse into any organization and pick any person there — closed by rewriting
  `MeContext.tsx` to resolve only from the account's own real identities, see its own
  layout entry above. The underlying endpoints it used to call for that free browsing
  (`/api/org-directory` and a full-roster `/api/org` fetch) are gone now, not just
  unreached — removed entirely rather than left as unused dead surface.
  `/api/org`, `/api/policy` GET, and `/api/audit/subject/:id` are still deliberately *not*
  re-gated server-side for other reasons — they're still real self-service transparency
  endpoints other legitimate flows reach without a session (do not blanket-gate them
  without re-checking every frontend caller first; found the hard way during the security
  audit that three of six initially-flagged endpoints turned out to be this, not
  oversights) — but this app's own frontend no longer calls any of them anonymously in
  practice, since nothing that uses them mounts before login anymore.

- **Verify the Gmail self-ask bridge against a real Gmail account.** Same shape of gap as
  Jira/OpenAI below, but for a different reason: Google OAuth itself is already configured
  with real credentials (`backend/.env`'s `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) — what's
  missing is a live round-trip through Google's own interactive consent screen, which needs
  a real person clicking through it, not an API key an agent could hold. The code is real:
  `server.ts`'s `/api/agent/ask` resolves a valid Gmail token
  (`gmailConnection.ts`'s `getValidGmailAccessToken`, refreshes if expired), runs one more
  router call scoped to `gmail` alongside the existing GitHub/Claude Code one, and if
  relevant, fetches and formats a real digest (`gmail.ts`'s `getEmailsSince`/
  `formatGmailDigest`) into that turn's prompt — never persisted as a claim, only ever
  fired for a genuine self-ask (see rule below). What's verified without a real account:
  the "not connected" path skips cleanly, and a deliberately invalid token fails cleanly
  against Gmail's real API rather than corrupting anything. Once someone connects a real
  Gmail account and asks something it should answer from: confirm a real digest lands in
  the prompt, then update this note.

- **Verify `resendEmail.ts` against a real Resend API key.** Same shape of gap as Jira/
  OpenAI below. Invite emails (org-admin invite, adding a person with an email) are wired
  up for real — the request follows Resend's documented API exactly, `emailConfigured()`
  gates it cleanly (invites still work, temp password still shown once, nothing crashes
  when `RESEND_API_KEY` is blank), and the UI already reflects whichever happened
  (`emailSent` in the API response). What hasn't happened: an actual message landing in
  a real inbox. Once there's a key: set `RESEND_API_KEY`/`EMAIL_FROM`, invite someone for
  real, confirm delivery, then update this note and drop the UNVERIFIED language in
  `resendEmail.ts`'s module comment.

- **Self-service password reset (the email half).** Everything that doesn't need email is
  built and live — see the password paragraph below. What's missing is the one case that
  structurally can't be covered without it: a personal account with no admin above it (a
  self-serve signup) that forgets its password. Admin-initiated reset can't help there by
  design, and the options that avoid email are all worse — security questions are
  deprecated by NIST 800-63B and recommended against by OWASP, and recovery codes nobody
  saves just move the support burden. The real answer is the standard emailed reset token
  (≥128 bits of entropy, hashed at rest, single-use, short expiry, all other sessions
  invalidated on success — OWASP's Forgot Password cheat sheet), which is blocked on the
  same thing the invite emails are: `resendEmail.ts` has never been exercised against a
  real `RESEND_API_KEY`. Do that first, then this. Note the distinction that made this
  worth deferring rather than skipping: email *verification* (confirm your address at
  signup) is a separate feature and still isn't planned; a reset *link* only needs
  delivery to work.

- **SSO.** Real login is password-based today (`backend/src/domain/auth.ts`, `accounts`'
  nullable `password_hash`, deliberately doubling as the future "SSO-only account" state).
  OIDC as an *additional* login method — a verified SSO email resolving to an existing
  `accounts` row the same way a password login does — is the natural next step, not a
  separate identity system. No real identity-provider tenant (Okta/WorkOS/Azure AD/Google
  Workspace) has been available to test against yet: same honest treatment as the
  Jira/OpenAI entries below once built — code and validation can be real, a live
  round-trip against a real IdP can't be claimed until one actually happens.

- **Slack/Teams surface.** Every adjacent product category that won real adoption (async
  standup tools, AI chief-of-staff agents — see `docs/published/market-fit-memo.html`)
  lives where people already are, not in a separate web app. Not started — needs a real
  Slack app + workspace to build and verify against, the same shape of gap as Jira below.

- **HRIS org-chart sync.** `OrgSetup.tsx`'s chart builder is manual entry today. Structure
  only (name/manager/title) belongs behind the same CANT boundary that already keeps
  compensation and performance data out of this system entirely — never more than that.
  Not started; no real HRIS (Workday, BambooHR, Rippling, ...) available to build against.

- **Self-serve billing.** Needed to land bottom-up on one team before there's an enterprise
  procurement motion at all. Not started; no real Stripe account available to verify
  against.

- **SOC2.** Not a code task — an audit/compliance process. The multi-admin RBAC and
  real session auth built this pass are load-bearing prerequisites for it, not the
  compliance work itself.

- **Verify `openaiCompatibleProvider` against a real OpenAI key.** Same shape of gap as
  Jira, same honesty about it. The adapter (`backend/src/integrations/openaiCompatible.ts`)
  is live-verified — router and synthesis both — but against a real local Ollama model
  (originally `llama3.2:1b`; now `qwen3:8b` for noticeably more coherent synthesis —
  Ollama returns its reasoning output in a separate `reasoning` field, never mixed into
  `content`, so this needed no adapter changes), not OpenAI's own API. It's vendor-neutral
  by construction (one fetch-based client speaking the standard chat-completions wire
  format, no Ollama-specific branching), so there's no known reason to expect different
  behavior against `api.openai.com`, but that's an expectation, not a confirmed fact — no
  `OPENAI_API_KEY` for the real service has been available to test with. Once one is:
  point `OPENAI_BASE_URL` back at its default, confirm a real ChatGPT-backed answer comes
  back through an org's main-agent ask (Admin → Organizations sets it now, not "Set up my
  agent" — see the org-level main agent paragraph above), then update this note and
  `docs/agent-to-agent-communication.md` §15a.

- **Verify the Databricks provider against a real workspace.** Same shape of gap as Jira/
  Airflow/dbt/Snowflake, same honesty about it. `databricks.ts` follows Databricks'
  documented OAuth M2M (service-principal client-credentials) flow and Jobs API 2.2 exactly,
  and was verified two ways without a real workspace: a deliberately invalid workspace
  subdomain fails clean (DNS rejection, caught, no 500), and the same request shape sent
  straight to Databricks' own real, live OAuth endpoint got back a genuine rejection from
  Databricks' own infrastructure — confirming the request format itself is correct, not just
  that malformed input fails safely. What hasn't happened: a real service principal
  connecting for real, and a real job-run digest landing in a synthesized answer. Once
  there's a real workspace: create a service principal, grant it `CAN VIEW` on a job, connect
  it for real, confirm a claim actually lands, then update this note and `databricks.ts`'s
  own module comment to drop the UNVERIFIED language.

- **Verify GitHub's MCP-backed commit read against a real PAT, and decide whether to roll
  the same pattern out further.** Same shape of gap as every other UNVERIFIED connector
  here: a deliberately invalid token reaches `api.githubcopilot.com/mcp/` for real and gets
  a genuine auth rejection, but a real end-to-end round trip (a real, current commit
  landing in a real claim through both the org and personal ask paths) hasn't happened yet.
  Once it does: update `github.ts`'s own module comment and this note, then decide — with
  real evidence, not just the pilot's design reasoning — whether `mcpClient.ts`'s
  `withMcpSession` pattern is worth extending to the other tools with official, remote MCP
  servers already identified (Atlassian/Jira/Confluence, HubSpot, Salesforce, Asana,
  Airtable, Monday, Trello, Dropbox, Slack), one at a time, the same read-only-allowlist
  discipline this pilot established.

- **Verify GitLab's and Linear's MCP-backed reads against real accounts — Linear first.**
  Notion is no longer part of this note: a real test already happened (see the CLAUDE.md
  paragraph on this batch), and it came back negative — `notion.ts` is back on plain REST,
  not pending further verification. GitLab and Linear carry genuinely different amounts of
  real evidence behind them: GitLab rests on real documented tool/parameter names but an
  unconfirmed exact response shape; Linear rests on third-party documentation of
  *unofficial* community servers, not a source confirmed to describe Linear's own official
  one. Both: a deliberately invalid credential reaches the real hosted endpoint and fails
  clean, but no real round trip has happened. Verify Linear first when a real account
  becomes available, precisely because it has the least real evidence supporting it, and
  treat a negative result (like Notion's) as a legitimate, expected possible outcome, not
  a bug to keep chasing — update `linear.ts`/`gitlab.ts`'s own module comments and this
  note once each is confirmed either way.

**Nango, considered and rejected** (researched 2026-08-17): its value is many end-users ×
many providers — N in-house OAuth flows becomes the real pain it solves. This project has
one OAuth provider and one PAT provider, for one developer, running locally. The cloud
option would put a real user's Gmail credentials in a third party's infrastructure,
against this project's own read-only/data-boundary framing; self-hosting to avoid that
means 5 extra services (Postgres, Redis, Elasticsearch, S3-compatible storage) next to the
one Postgres container this already runs, and the free self-hosted tier excludes
Functions/syncs regardless. Against that, it would only have deleted a small, already-
working token-refresh block and two routes. Don't re-suggest without new information.

Escalation triage is built — see `docs/escalation-triage.md` and `domain/escalations.ts`.
Self-service tool connectors (Claude Code, GitHub, Codex CLI, Gemini CLI all real) are
built — see `docs/agent-to-agent-communication.md` §13.

**A generic, catalog-driven connector framework replaces one-off per-tool plumbing, and
grows the org-mode connectable-tool catalog from 2 (GitHub, Jira) to 20.**
`backend/src/integrations/connectorCatalog.ts`'s `CONNECTOR_CATALOG` is the single source
of truth — auth shape, required fields, category, and a three-tier `status` — driving both
backend validation and one generic frontend UI (`ConnectorsPanel.tsx`, org-mode only,
appended after GitHub/Jira/Gmail in `SetUpMyAgent.tsx`) instead of a bespoke component per
tool: a "Connect a tool" dropdown grouped by category, a form generated from that
connector's own field list, and a "Connected tools" card list — all reading the same
`person.surfaces` state the existing Connected Surfaces panel already shows, so the two
views can't drift. `GET/POST/DELETE /api/person/:id/connectors[/:key]` are the generic
endpoints (same `requireSelfIfLoggedIn` gate as GitHub/Jira); connecting calls
`repo.updatePersonSurface(id, key, 'connected')`, the one call that already makes a
surface show up everywhere — Connected Surfaces, coverage %, and (this is the point) the
candidate list `resourceProviders.ts`'s `gatherAll` narrows before asking the org's real
main agent to pick which connected tools are actually relevant to a given question
(`selectRelevantSurfaces`) and only then calling `ingest()` on that subset. Nothing new was
built for "discovery" or "the agent knows what's connected" — that pipeline already existed
and just gained more real providers to route across. No schema migration was needed: every
new connector reuses the existing generic `person_oauth_tokens` columns (`site_url`
doubles as Confluence's site, GitLab's instance, or Zendesk's subdomain).

Three tiers, matching this codebase's established honesty convention (Jira/OpenAI/Gmail
before their credentials existed) rather than claiming more than what's actually been
proven: **`'live'` (8 new, genuinely ingest data into claims)** — Linear, Notion,
Confluence, Asana, GitLab, HubSpot, Zendesk, Google Calendar (the last reuses Gmail's own
OAuth token, just adds a `calendar.readonly` scope). Each has its own client module
(`linear.ts`, `notion.ts`, etc., same `validateAndIdentify`/`getRecentActivity`/
`formatDigest` shape as `github.ts`) and an `ingest<Tool>Claim` in `realClaims.ts`
registered into `resourceProviders.ts`'s `PROVIDERS`. Checked the same way Jira's request
shapes originally were — deliberately invalid credentials against each tool's real API,
confirmed each fails cleanly with a real provider-specific rejection and zero 500s — for
7 of the 8 (all but Calendar, which needs a live Gmail OAuth round-trip that remains
unverified for the same pre-existing reason as Gmail itself). **Read that check for exactly
what it is.** Jira passed it for months and still could not work at all against a live
site: Atlassian had removed the endpoint outright, and an invalid credential returns a
clean rejection whether or not the endpoint you're calling still exists (see the
Jira/Notion verification paragraph below). It proves the request is well-formed and
failures are handled; it cannot prove the endpoint is real, current, or returns what the
parser expects. Of these 8, **Notion is now genuinely live-verified** against a real
workspace; the other 7 still have not round-tripped against a real account — update this
note as each one does.
**`'connectable'` (5 new, connect flow real, ingestion not wired yet)** — Trello, Airtable,
Monday.com, Figma, Discord; Trello's connect flow is live-verified the same way (real
rejection, no 500). **`'coming-soon'` (5, genuinely can't connect yet)** — Slack,
Salesforce, Microsoft 365, Zoom, Dropbox: each needs the platform operator to register a
developer app with that vendor first, shown disabled in the dropdown rather than a broken
connect button (live-verified: the option carries a real `disabled` attribute and a
disabled `<option>` cannot be selected in a live browser). Disconnect is live-verified
end-to-end at the DB level: `DELETE /api/person/:id/connectors/:key` removes the
`person_oauth_tokens` row and resets `people.surfaces[key]` back to `'absent'`, so the very
next `gatherAll` stops treating that tool as a discovery candidate.

**The catalog grows from 20 to 23 tools with a data-engineering category — Airflow, dbt
Cloud, and Snowflake — following a dedicated research memo's own recommended sequencing,
not built as an ad hoc addition.** The memo (published as an artifact, researched against
each vendor's real docs before any code was written) drew one hard line: a *status*
connector (did the pipeline run, did it pass) fits this project's existing shape exactly,
but a connector that lets an agent compose and run its own SQL against a warehouse is a
different, much riskier product — it would let the *connector* decide what data a
requester ultimately sees, which is exactly the job `policy.ts`'s deterministic engine
exists to keep out of an LLM's hands. All three new connectors are the first kind only:
every query any of them runs is fixed, connector-authored, and reads metadata (DAG run
state, job run status, `QUERY_HISTORY`/`TASK_HISTORY`), never a query built from a
person's question or a read against real table contents. The ad hoc warehouse-query
product the memo describes was deliberately *not* built — it needs its own explicit
product sign-off and threat model, not a slot in this framework.

Auth shape differs more between these three than any three tools added before them, each
matching that vendor's own documented least-privilege guidance rather than one uniform
pattern: Airflow uses HTTP Basic auth against a dedicated Viewer-role user (OSS/2.x's
REST API — the memo's research found Airflow 3.x's short-lived JWTs and most managed
offerings' token models don't hold as a long-lived stored credential the way this
project's other connectors expect, so this targets self-hosted OSS/2.x specifically);
dbt Cloud uses a Service Account Token scoped to Read-Only/Metadata permissions (dbt's own
docs recommend this over a personal PAT for exactly this kind of integration); Snowflake
uses RSA key-pair JWT auth, Snowflake's stated preference over passwords for service
accounts. The Snowflake piece needed genuinely new code, not just a new client module:
`snowflake.ts` builds and signs that JWT by hand with Node's own `crypto` module (RS256,
the exact `iss`/`sub` claim format and SHA-256 public-key-fingerprint procedure from
Snowflake's docs) — no JWT library dependency, same "no new dependency" convention
`domain/auth.ts` already set for password/session hashing. Live-verified as far as a real
account allows without one: the constructed JWT's RS256 signature was checked against its
own public key and genuinely verifies (proving the encoding and signing are correct, not
just "didn't throw"), and all three connectors reach their real APIs and fail cleanly on
deliberately invalid credentials — zero 500s. A real successful connect-then-ask round
trip remains unverified for the same honest reason every other new connector in this
project does; update this note once a real Airflow/dbt Cloud/Snowflake account is
available.

Snowflake's private key is the first connector field that's genuinely multi-line (a PEM
block, not a token) — `connectorCatalog.ts`'s `ConnectorField` gained a `multiline` flag,
and `ConnectorsPanel.tsx` renders a `<textarea>` for it instead of the usual single-line
input, the first real extension to the generic field-rendering system since it was built.
A shared `pipelineDigest.ts` formats "did it run, did it pass" for all three — the memo's
own recommendation to build this once rather than three near-duplicate formatters, since a
pipeline run reads differently from "issues assigned to you" (a pass/fail count first,
failures listed after, rather than a bare list of every run).

**The same connector catalog also reaches a personal (no-org) account — self-set, no
admin, mirroring how `account_main_agent` already parallels `org_main_agent`.** Found
live, asked for directly, in the same spirit as the personal-main-agent work above: a
person with zero linked `people` rows (added as an org admin by email but never a chart
person, or simply never joined anyone's chart) still gets to plug in Linear, Notion,
GitLab, and the rest — not just a private chat with nothing behind it. Since a personal
account has no `people` row to key connections off of at all, this is a second, parallel
storage table rather than a stretch of the existing one: `account_oauth_tokens` mirrors
`person_oauth_tokens` exactly (same columns, `account_id` instead of `person_id`), the same
"same shape, different owner" idiom `account_main_agent`/`personal_asks` already
established. Every one of the 12 PAT-based connectors (the 7 live-tier tools minus
Calendar, plus all 5 connectable-tier tools) grew one small additive `<Tool>Account*`
function alongside its existing person-keyed ones (`genericConnection.ts` grew the same
account-keyed counterparts) — none of the original, working person-keyed code was touched.
`ConnectorsPanel.tsx` now takes an `owner: { kind: 'person'; personId } | { kind:
'account' }` prop instead of a bare `personId`, dispatching to `GET/POST/DELETE
/api/accounts/me/connectors[/:key]` (gated on nothing but being logged in as yourself,
same posture as `/api/accounts/me/main-agent`) instead of the person-keyed routes — one
component, one catalog, either owner. GitHub/Jira stay org-chart-only by design (unchanged
scope boundary), and Calendar is excluded from the personal panel too since it rides on
Gmail's own OAuth token, which a personal account doesn't have.

Real discovery reaches personal accounts as well, not just a connected-tools list: a new
`personalConnectors.ts` module holds `ACCOUNT_DIGEST_PROVIDERS`, the personal counterpart
to `resourceProviders.ts`'s `PROVIDERS` — except a personal ask has no claims table to
write into (no `org_id` to hang one off), so nothing here ever becomes a claim. Instead
`POST /api/agent/ask-personal` runs the same router pattern the org path's Gmail bridge
already uses: narrow the account's own connected tools to whichever are plausibly relevant
to this question (`selectRelevantSurfaces`, the same router call, same personal main
agent), fetch a real digest from each relevant one, and feed the results into *that turn's*
answer only — never persisted as anything but the label in a new `personal_asks.
consulted_sources` column (mirroring `audit_log`'s own `consultedSources`, just as its own
column since there's no snapshot blob here). This needed `ModelProvider.converse()` itself
to genuinely change, not just its caller: it grew an optional final `sections` parameter
(both `anthropic.ts` and `openaiCompatible.ts`), enriching the conversation when connected-
tool data is relevant without adopting `synthesize()`'s hard "answer only from this"
constraint — a personal chat with nothing connected, or nothing relevant this turn, must
still just answer normally, which is exactly why `converse` stayed a separate method from
`synthesize` in the first place. Live-verified end-to-end against a genuinely personal
account (an org-admin-only login with zero chart identities, created via a real admin
invite that intentionally never adds a `people` row) rather than assumed from reading the
code: connect correctly reaches Linear's real API and fails clean on a deliberately invalid
key (same proof pattern as every other UNVERIFIED connector in this project); with a fake-
but-present credential inserted directly, the full pipeline was traced live end-to-end — a
locally-run Ollama personal main agent's router genuinely selected Linear as relevant to
"What issues are assigned to me in Linear right now?", `fetchDigest` genuinely reached
Linear's real API, got a real 401, and that single failure was correctly absorbed
(`Promise.allSettled`, same resilience as `gatherAll`) without breaking the turn or the
chat; disconnect was confirmed at the DB level (`account_oauth_tokens` row removed,
`GET .../connectors` immediately reflects `connected: false`). A real successful
connect-then-ask round trip (a genuine Linear/Notion/etc. account, not a deliberately
invalid credential) remains unverified for the same honest reason every other new
connector in this project does — update this note once one happens.

**GitHub, Jira, and sub-agent registration (Claude Code/Codex CLI/Gemini CLI) reach
personal accounts too, not just the generic connector catalog.** Found live, reported
directly, right after the connector catalog first extended to personal accounts: "the
data engineering tool should be there along with the previous tools like claude, claude
code, codex, jira, github... I cannot see the ones that were previously there." Real gap,
not a misunderstanding — `PersonalMainAgentPanel` had never gotten GitHub/Jira/sub-agent
sections at all, and the generic catalog's own `HANDLED_ELSEWHERE` exclusion (GitHub/Jira/
Calendar assumed to have "their own dedicated section elsewhere on this page") was true
for org mode and false for personal mode, so those three tools were structurally
unreachable there — worse than merely hidden. `PersonalToolsPanel.tsx` is a new,
genuinely separate component (not the org-mode page's `owner` prop threaded through,
unlike `ConnectorsPanel`) — that page's GitHub/Jira/sub-agent state is deeply intertwined
with org-only concepts (the org main agent, per-sub-agent live query), so extracting it
cleanly would have meant rewriting working code for no functional gain; a smaller,
purpose-built component covering just connect/status/disconnect/token-generation was the
lower-risk path, sharing only the pure `SOURCE_LABEL`/`ingestSnippet` helpers (exported
from `SetUpMyAgent.tsx`) rather than any stateful logic.

The real new backend piece is Codex CLI/Gemini CLI's event-push mechanism, which had no
account-scoped counterpart at all: `account_runtimes`, `account_ingest_tokens`, and
`account_ingested_events` mirror `person_runtimes`/`ingest_tokens`/`ingested_events`
exactly, and `POST /api/ingest/:source` now tries a person's token first, then an
account's — the two token spaces are disjoint (one hashed value can never match both
tables), so this costs one extra lookup only on the account path, never a real ambiguity.
GitHub/Jira reuse their own existing `githubConnection.ts`/`jiraConnection.ts` client
modules, each growing the same `save/get/disconnect...AccountConnection` trio every other
connector's account variant already has. `claudeCodeActivity.ts` gained an `accountId`
parameter alongside its existing `personId` one, merging an account's own pushed events
into the same local-transcript scan every caller already shares.

One real bug found and fixed live, twice, in the same sitting: the first version of the
personal digest bridge's Codex CLI/Gemini CLI/Claude Code "connected" check looked at
whether the account had *registered* that runtime (`account_runtimes`) — but `codex` and
`gemini-cli` were never real `runtime_catalog` entries at all (confirmed this is also true
of org mode's own "Register another agent" dropdown, not something new this broke), so
that check could never be true and those two tools would never surface. The second bug
was closer to home: Claude Code's status check was set to unconditionally `connected:
true` ("always worth trying"), which turned out to mean *every* personal ask for *every*
account would attempt `claudeCodeActivity.ts`'s local-transcript scan regardless of
whether that account had ever touched Claude Code — caught live when this exact session's
own 254MB same-day transcript (this file's own conversation, still growing) made one real
`ask-personal` call hang for minutes. Org mode never had this problem because
`ingestClaudeCodeClaim` only scans once `person.surfaces['claude-code']` is actually
`'connected'` — set at registration or first pushed event, never unconditionally. Fixed to
check the same two real signals for a personal account (`account_runtimes` registration
or at least one real pushed event), matching org mode's actual gate instead of a stricter-
sounding comment that didn't match what the code did. Live-verified end-to-end afterward,
fast (no hang): a real ingest token generated, a real event pushed through
`/api/ingest/codex`, and a real `ask-personal` call whose router genuinely selected
"Codex CLI" as relevant and answered from the real pushed activity — `consultedSources`
confirmed it, not just the answer text.

Model-agnostic main agents are built and live-verified against a real local Ollama model —
one `ModelProvider` adapter each for Claude and for anything OpenAI-compatible (ChatGPT,
or a self-hosted/open-source model — same adapter, `OPENAI_BASE_URL` is the only knob),
never hardcoded to one vendor — see `docs/agent-to-agent-communication.md` §15/§15a. The
main agent is an org-level setting, not a per-person one: one registration
(`org_main_agent`) shared by everyone in the org, set only by an admin
(`POST /api/organizations/:orgId/main-agent`, `requireOrgRole` 'admin'). Anyone who's a
real person in an org's chart sees this read-only in "Set up my agent" — no per-person
override within an org. `person_runtimes` still exists but only ever holds personal
sub-agents now (Claude Code, GitHub, etc. as status-check tools the org's main agent can
query); it lost its old main/sub distinction entirely along with it.

**An account connected to no organization at all gets a genuinely personal main agent
instead — self-set, no admin involved, since there's no org to share it with.** Found
live, asked for directly: "when the user is not part of the organization, he or she
should be able to setup the main agent by himself... only setting up the organization and
working with the organization needs the admin access." `account_main_agent` mirrors
`org_main_agent`'s shape (runtime, optional bring-your-own credentials) minus `scope` —
no IT/Security approval workflow makes sense for an individual's own key, so it's always
immediately usable. `GET/POST /api/accounts/me/main-agent` are gated on nothing but being
logged in as yourself (`currentAccountId`, no `requireOrgRole`, no elevation — this never
touches org data). The real "Ask yourself" chat is reused as-is, not rebuilt: `MyAgent.tsx`
and `SetUpMyAgent.tsx` both derive `personal` the same way `App.tsx`'s `Shell` derives
`hasOwnIdentity` (`useAuth().people.length === 0`) and branch early, skipping every
org-chart concept — no claims, no coverage panel, no policy engine, no disclosure
machinery, since none of that has anything to do with a private chat nobody else could
ever ask about. History lives in a new `personal_asks` table, not `audit_log` — that
table's `org_id`/`target_person_id` are `NOT NULL REFERENCES`, so it structurally can't
hold this, and none of its tamper-evident/disclosure properties (rule 2) apply to a chat
with no one else who could ever be shown it. One real design fix along the way: a personal
ask has zero "activity sections" to stay grounded in by construction (personal accounts
have no connected sources in this version — GitHub/Jira/Gmail sub-agents stay org-chart-
only, a deliberate scope boundary, not an oversight), and the existing `synthesize()`
method throws when given zero sections on purpose (an org self-ask with nothing connected
should say so, not hallucinate). Calling it with an empty array for a personal ask threw
every time — found live testing this exact path. Fixed by adding a genuinely separate
`ModelProvider.converse()` method (both `anthropic.ts` and `openaiCompatible.ts`) for a
plain, ungrounded conversation, rather than weakening `synthesize()`'s real "never invent
beyond the real data given" guarantee for the org path to accommodate a use case that was
never about grounded summarization in the first place.

**An org member can now run their own personal main agent alongside the org's, not
instead of it — two genuinely separate agents, each with its own tool connections, not
one shared thing.** Found live, reported directly: "I am also part of the organization
Red Hat... I should be able to set up my main agent and connect my tools to my main agent
so that whenever I need to find the solution for myself, I can call directly from the main
agent... but only certain tools to the organizational main agent." Checking the backend
before changing anything showed this mostly already worked — `account_main_agent`,
`account_oauth_tokens`, `account_runtimes`, `account_ingest_tokens`, `personal_asks`, and
`POST /api/agent/ask-personal` are all keyed purely on the logged-in account, with zero
dependency on org membership anywhere in that code path. The only thing stopping an org
member from using their own personal agent was a strict, mutually-exclusive frontend
branch (`identities.length === 0 ? <PersonalMainAgentPanel /> : <OrgSetUpMyAgent />`) that
never let both render for the same person. `SetUpMyAgent.tsx` now always renders
`PersonalMainAgentPanel` (your own agent, your own tools — nobody else, org or otherwise,
can see this) plus `OrgSetUpMyAgent` whenever `identities.length > 0` (the org's agent,
set by its admin, tools you connect here feed the org's disclosure machinery through
policy same as always) — one page, two independent sections, one heading instead of each
component's own. `MyAgent.tsx` grew a parallel `usePersonalAgent` toggle ("Ask yourself" /
"My personal agent", shown only for an org member — a true no-org account has no toggle at
all, it's always on) driving a derived `showPersonalChat` that every chat data/copy branch
reads instead of `personal` alone; the connected-surfaces/never-ingested page chrome stays
keyed on `personal` alone, since an org member using their personal agent still sees their
own org connected-surfaces panel — only the chat side switches. The history-reload
`useEffect` had to split in two (org roster fetch vs. chat history reload) so toggling
doesn't needlessly refetch surfaces, and so switching resets `activeConversationId` —
without that reset, an org thread id left over from before a toggle would point at nothing
inside `personalEntries`, landing on a silently blank chat instead of a real one.

**One catalog-driven "Connect a tool" dropdown now covers every tool, replacing five
scattered panels.** Reported directly alongside the above: "everything is a tool... it
should be under the same drop down... based on that specific tool, the required
configuration entry UI should appear." GitHub and Jira were already real
`connectorCatalog.ts` entries the whole time — only ever excluded from `ConnectorsPanel`'s
dropdown by a frontend constant, not by the catalog itself — so folding them in meant
registering their existing connect/status/disconnect functions
(`githubConnection.ts`/`jiraConnection.ts`, both person- and account-keyed already) into
the generic `CONNECT_HANDLERS`/`STATUS_HANDLERS`/`DISCONNECT_HANDLERS` dispatch maps
`server.ts` and `personalConnectors.ts` already used for every other connector, not
rebuilding anything. Claude Code/Codex CLI/Gemini CLI needed a real new `authType:
'ingest-token'` on `ConnectorDef` (`fields: []` — the generic field-driven form never runs
for these three): a PAT connector is "submit once, one Disconnect forever," but an
ingest-token tool holds multiple independently-revocable tokens with a one-time-shown
secret, a genuinely different transaction, so `ConnectorsPanel.tsx` branches its open-tool
panel on `authType` — `'oauth-google'` renders the Gmail connect link, `'ingest-token'`
renders the real token-management UI (lifted from `SetUpMyAgent.tsx`'s old bespoke block,
`ingestSnippet()`/`SOURCE_LABEL` now exported from there for reuse), everything else the
existing form. A "Connected tools" row for an ingest-token tool shows "N active token(s)" +
`Manage` instead of a bare `Disconnect`, since revoking *which* token a single Disconnect
would hit is genuinely ambiguous once more than one exists. One deliberate trap avoided:
the *existing* `ACCOUNT_STATUS_HANDLERS['claude-code'/'codex'/'gemini-cli']` encode a
richer, different question ("registered runtime OR pushed event — is this worth
`ask-personal`'s digest bridge scanning for") that a prior phase's fix depends on to avoid
a real hang (see the local-transcript-scan note elsewhere in this file); the dropdown only
needs "does this person/account have ≥1 active token to manage," so that got its own,
separate `ACCOUNT_INGEST_TOKEN_STATUS`/panel-scoped person-side map, checked first, rather
than mutating the existing one. Gmail itself stays its own dedicated panel, never becomes a
`ConnectorDef` — `gmail` isn't even a `SurfaceKey` (rule 4-adjacent: it must never become a
`claims`-row a manager could see via cross-person Ask). `calendar`, by contrast, *is* a
real `SurfaceKey`/`ConnectorDef` and moved into the dropdown — which surfaced a real,
previously-invisible bug found while researching this: neither `POST
/api/oauth/gmail/callback` nor `DELETE /api/person/:id/gmail` ever actually touched
`person.surfaces.calendar`, despite the catalog's own helpText already claiming Gmail
enables it. Invisible only because `calendar` was excluded from every UI that would have
shown it before now. Fixed as a companion change (both call sites now set/reset `calendar`
alongside Gmail itself) and live-verified at the DB level: manually marking a person's
`calendar` surface `'connected'`, then calling the real disconnect endpoint, correctly
flipped it back to `'absent'`. The forward direction (OAuth callback setting it on
connect) is code-reviewed and typechecked but not yet round-tripped through a real Google
consent screen, same pre-existing honest caveat as Gmail itself (see "Where to go next").
Also live-verified: the account and person connector pools stay genuinely disjoint through
this new shared routing — connecting/failing GitHub or generating an ingest token on one
side never touches the other's status, checked directly against the running dev API.

**Sub-agent (LLM runtime) registration and Gmail fold into that same one dropdown too —
found live, reported directly, right after the GitHub/Jira/ingest-token merge above:
"the subagent and tools [should be] in the same drop down... put Gmail also under the
drop down, it's just a tool."** Both are structurally *not* `ConnectorDef` catalog
entries — a runtime registration lives in `person_runtimes`/`account_runtimes`, a wholly
separate table from `person_oauth_tokens`, and Gmail can never become one at all (it isn't
a `SurfaceKey`; rule 4's boundary — it must never become a `claims`-row a manager could
see via cross-person Ask — is exactly why it was still a bespoke panel after the first
merge). Rather than forcing either into the catalog's `SurfaceKey`-typed shape (which would
have meant weakening that boundary for Gmail, or fabricating a fake `SurfaceKey` for every
LLM runtime), `ConnectorsPanel.tsx` now fetches the runtime catalog/registration state
(`personRuntimes`/`accountRuntimes`, the same endpoints "Register another agent" always
used) and, for a person/org owner only, Gmail's own status, and merges all three into one
dropdown and one "Connected tools" list purely on the frontend — the backend architecture,
and rule 4 itself, are both untouched; no schema or endpoint changed. `openKey` doubles as
the discriminator across all three (`'gmail'` is a reserved sentinel that can't collide
with a real `SurfaceKey` or runtime key), so exactly one of a connector's form, the
ingest-token manager, a runtime's detail card, or Gmail's connect link renders at a time.
Selecting a sub-agent opens the same detail card "Register another agent" always
showed (vendor/context/host/note, a blocked/no-DPA warning, "Request approval" instead of
"Connect" when unapproved) — relocated, not rebuilt — and a registered one keeps its
existing "What did it complete today?" query button, pending-scope "Withdraw request"
state, and (for Claude Code specifically, person/org mode only) the "Ask it live" real
`claude` CLI shell-out block, all now living in the "Connected tools" list alongside
data connectors instead of a separate grid. Calendar keeps its own catalog entry and its
"Connect Gmail" link (it's a real org-visible surface with real claims) *and* Gmail gets a
first-class entry of its own (a self-ask-only digest source that's never a claim) — two
entries that happen to drive the same OAuth flow but represent genuinely different stored
state, kept deliberately separate rather than collapsed into one to avoid quietly blurring
that boundary. `OrgSetUpMyAgent` and `PersonalMainAgentPanel` lost the "Agents under X"/
"Register another agent" grid and the "Personal data sources" Gmail panel entirely — what's
left is just the read-only "Main · aggregator agent" display (still admin-set, still
org-level, never touched by this) plus one `ConnectorsPanel`.
`components/PersonalToolsPanel.tsx`, which after the first merge held only sub-agent
registration, is now fully redundant and was deleted outright rather than left as unused
dead surface. Live-verified against the running dev API rather than assumed from reading
the code: registered a real sub-agent through the exact endpoint the merged dropdown calls,
confirmed it appears in the registered list, queried it, and disconnected it — all through
the same person-keyed runtime endpoints now driving `ConnectorsPanel`'s UI.

**Databricks joins the data-engineering catalog as a fourth Tier A status connector,
researched fresh rather than assumed from the Airflow/dbt/Snowflake shape.** Requested
directly, for both personal and organizational use. Its auth is genuinely different from
the other three: Databricks' own current documentation (docs.databricks.com's OAuth M2M
guide) recommends a service principal with OAuth client-credentials over a personal access
token specifically for automated access — a PAT is tied to a human account, inherits that
human's full permissions, and stops working the moment they leave; a service principal is
an application-only identity that can be granted `CAN VIEW` on just the jobs it needs to
read, matching the least-privilege posture this project already picked for Airflow
(dedicated Viewer user), dbt (Service Account Token), and Snowflake (RSA key pair) each on
that vendor's own terms rather than one uniform pattern. `databricks.ts` stores the service
principal's `client_id`/`client_secret` (never a long-lived access token) and exchanges
them for a fresh, one-hour bearer token at call time via the workspace's own `/oidc/v1/token`
endpoint — the same "compute fresh per call, never cache" shape `snowflake.ts`'s own JWT
signing already established here, just an HTTP token exchange instead of local signing.
Reads are the same Tier A boundary as the other three: `GET /api/2.2/jobs/runs/list`
(`job_id` deliberately omitted — Databricks' own documented behavior is to list runs across
every job in the workspace when it's left out, the same one-call "activity across the whole
instance" shape Airflow's `dag_id=~` wildcard already gives here) — did a job run, did it
succeed, never a query an agent constructs or a read against real notebook/table contents.
Reuses `pipelineDigest.ts` unchanged (a fourth "did it run, did it pass" formatter would
have been the near-duplicate the memo's Phase 3 already built this to avoid), and the
existing `pat-with-site` form-rendering path (`ConnectorField`'s generic 3-field form
already handles "site URL + two more fields" regardless of what those fields mean
underneath — no frontend code changed at all). `client_id` is packed alongside
`workspaceUrl` into the one `site_url` storage slot genericConnection.ts provides, the same
technique `snowflake.ts` uses to fit account+username+warehouse into that same slot.
Live-verified two ways rather than one, both without a real workspace: a deliberately
invalid workspace subdomain fails clean through the connect endpoint (DNS-level rejection,
caught, no 500) for both the person- and account-keyed paths; separately, the exact same
request shape (Basic auth of `client_id:client_secret`, `grant_type=client_credentials&scope=all-apis`)
was sent straight to Databricks' own real, live OAuth endpoint
(`accounts.cloud.databricks.com/oidc/v1/token`) with fake credentials, got back a genuine
`invalid_request` rejection from Databricks' own infrastructure, and that identical request
run back through `databricks.ts`'s own connect endpoint surfaced the same clean rejection —
stronger proof than the DNS-failure case alone, since it confirms the request format itself
is correct against Databricks' real API, not just that malformed input fails safely. A real
successful connect-then-ask round trip remains unverified for the same honest reason every
other new connector in this project does; update this note once a real Databricks workspace
is available. No schema migration needed — `provider` on `person_oauth_tokens`/
`account_oauth_tokens` is untyped `text`, and `surfaces_catalog` is seed-data, not schema.

**A personal ask no longer falsely claims "I don't have access" for a genuinely connected
tool that just had nothing to report.** Found live, reported directly: a real personal
main agent (the user's own Anthropic key) with a real, connected GitHub answered "I don't
have access to your GitHub account or real-time data" when asked to list repositories.
Root cause, traced through `POST /api/agent/ask-personal`: when a connected tool's digest
came back empty (`fetchDigest` resolving to `null` — e.g. GitHub's own connector only ever
reads pull requests opened or reviewed, never a repository list, and none were found in
today's window), that tool was silently dropped from `sections` entirely, same as if it
had never been connected at all — `converseFreely`/`converse` (anthropic.ts and
openaiCompatible.ts both) had zero signal the tool existed, so a bare, ungrounded Claude
call produced a plausible-sounding but false denial. Fixed by keeping every genuinely
*checked* (relevant + connected) tool in `sections` even when its digest is empty, with an
honest note built from the same `reads` description the router itself already saw (e.g.
"Connected — reads: pull requests you opened and reviews you gave. No matching activity
found for today.") — the model now has to say what's actually true (connected, narrower
scope than asked, or genuinely nothing today) instead of denying the connection outright.
Both `converse()` implementations' intro line changed to match ("never claim a tool listed
there isn't connected"). Live-verified as far as possible without a real GitHub PAT or a
platform-wide Anthropic key in this dev environment (both empty locally) — the branch logic
itself (`Promise.allSettled`'s `fulfilled` result with a falsy value, previously treated
identically to "never happened," now distinguished and given the same honest-empty
treatment) was traced directly against `formatGithubDigest`'s real `null`-on-empty
contract; a full live retest needs the reporting user's own real account.

**GitHub reads commits now, not just pull requests and reviews** — closing a gap that
predates this session: `surfaces_catalog`'s own `github` entry has promised "Pull requests,
reviews and commit metadata" since this connector's first version, but `github.ts` never
actually fetched commits — `github.ts`'s own module comment even flagged it as a planned
"v2 addition" that was never built. Found live, reported directly, right after the honesty
fix above (the same real account had genuine commits with zero PR/review activity — the
digest was accurately empty *and* the connector still wasn't reading everything it claimed
to). `getRecentGithubActivity` now also queries GitHub's Search Commits API
(`GET /search/commits`, `author:<login> author-date:>=<date>`) alongside the existing PR
searches — a genuinely different item shape (`commit.message`/`commit.author.date`, not
`title`/`updated_at`; `repository.full_name`, not a URL to slice) but the same
`application/vnd.github+json` Accept header every other call here already sends, no preview
header needed. Commit messages are trimmed to their first line, same as a PR title — never
the full body, and never a diff or file contents either way, unchanged from this
connector's original scope promise. `deterministicGithubClaimText` and the org-mode claim's
`evidence.kind`/`note` (realClaims.ts) updated to count and describe commits too, not just
PRs/reviews — they'd gone stale in the exact same "promised more than delivered" way.
Live-verified against GitHub's real API: the exact commit-search request shape reaches
`api.github.com` and gets a genuine `401 Bad credentials` on a deliberately invalid token
(not a malformed-request error), and every field the parser reads
(`commit.message`/`commit.author.date`/`repository.full_name`/`html_url`) was confirmed
against a real, live public response (`torvalds/linux`) — the strongest verification this
connector has had without the reporting user's own token.

**A personal ask can now widen its digest window past "today," the same "Today/This week"
toggle org self-ask already had.** Found live in the same testing session as the two fixes
above: with the honesty fix in place, a real personal ask correctly reported "no commit
activity today" and asked "want me to check a wider range?" — but there was no way to
actually do that. `POST /api/agent/ask-personal` was hardcoded to `since = start of today`
with no way to override it, unlike the org self-ask path (`POST /api/agent/ask`), which
has taken an optional `window: 'today' | 'week'` since early in this project. Fixed by
mirroring that exact same window computation into `ask-personal` (`window` in the request
body, `since.setUTCDate(since.getUTCDate() - 7)` for `'week'`, unchanged default
otherwise) and threading it through `api.askPersonal` and `MyAgent.tsx`. The Since:
Today/This week pills in the chat header — previously hidden for personal chat, since they
did nothing there — now show for both org and personal modes, since they're functional in
both now. The honest "connected, nothing found" note the previous fix added also had to
stop hardcoding "today" once the window could genuinely be a week — it now names whichever
window was actually checked.

**The "Today / This week" toggle above was removed again, one commit later — replaced by
the router inferring a time window per tool, per question, rather than one manual choice
applying to every connected surface at once.** Pushed back on directly, immediately after
the toggle above shipped: "we will connect 100s of tools and we cannot do this to all" — a
manual, global, two-option picker a person has to set by hand before every question
doesn't scale, and can't express anything more specific than "today" or "this week" even
for the tools it does apply to. `selectRelevantSurfaces` (`modelProvider.ts`, both
`anthropic.ts` and `openaiCompatible.ts`) now returns `Map<surfaceKey, sinceDays>` instead
of `Set<surfaceKey>` — the router decides, per surface, both whether it's relevant *and*
how many days back to look, inferred straight from the question's own wording ("today" →
1, "this week" → 7, "this month" → 30, no time frame stated — "what's my latest X" — →
`orchestrator.ts`'s new `DEFAULT_SINCE_DAYS`, 90). `parseRelevantSurfaces` tolerates a bare
surfaceKey string alongside the richer `{surfaceKey, sinceDays}` shape (a smaller/local
model may not follow the new format exactly), defaulting that entry to the same generous
window rather than treating the whole response as a parse failure — same fail-open
philosophy as before, just carrying a time value now too. `gatherAll()` and
`ask-personal`'s digest bridge (and the org self-ask's own Gmail bridge, which had the same
single-`since` shape) all compute each provider's own window from its own map entry now,
instead of one `since` shared by the whole run. The "Today / This week" UI (`MyAgent.tsx`,
`Ask.tsx`) and the `window` request-body field it drove (`POST /api/agent/ask`,
`POST /api/agent/ask-personal`) were deleted outright, not kept as a disabled or optional
path alongside the router — the point was one fewer manual thing to scale per tool, not two
ways to arrive at the same window. `docs/agent-to-agent-communication.md` gained a new §6b
documenting this on top of §6a's original question-aware-selection design.

**GitHub's commit search silently never covered private repositories, one more layer
under the same two bugs above.** Found live, immediately after the router fix landed: with
the window now genuinely searching 90 real days, a real, connected GitHub with real
commits still reported "no commit activity found" — an honest report of what the query
found, not of what actually happened. Root cause, confirmed against GitHub's own
documentation: `author:<login>` alone works for `search/issues` (PRs, reviews) once
authenticated, but `search/commits` specifically requires an explicit `repo:`, `user:`, or
`org:` qualifier to include private repositories at all — a query with just `author:`
silently searches public commit history only, authenticated or not. Fixed by running a
second query scoped `user:<login>` (repos that account owns, private included) alongside
the original `author:<login>`-only one, merged by commit sha rather than concatenated
(their result sets overlap for any public repo the person owns). The original query still
earns its place: it also catches commits in repos the person doesn't own but has pushed to
(a public org project, a contribution to someone else's repo) that `user:<login>` alone
would miss. Live-verified the same way as the commits feature itself: the new
`author:<login> user:<login> author-date:>=<date>` shape was confirmed syntactically valid
against a real public account first (`torvalds`, `user:` scoping correctly narrowed
results to repos he actually owns rather than an unrelated match), then run through
`getRecentGithubActivity`'s own request shape against a deliberately invalid token and
confirmed a clean 401 from GitHub's real API, not a malformed-request error.

**A third layer under the same two bugs, found live a second time with the real reporting
user's own account: GitHub's Search API — commits included — is not the live git graph,
it's an asynchronous Elasticsearch index with documented real lag (GitHub's own community
threads: minutes to 48+ hours, sometimes longer).** The `user:`-scoping fix above was
correct and stayed, but a real, connected GitHub with real, current commits still reported
"no commit activity" a second time — not because the query was wrong, but because
`/search/commits` structurally cannot be trusted for "what's my *latest* commit," the
exact question most likely to land inside the indexing lag window. Fixed by dropping
`/search/commits` for commits entirely: `getRecentGithubActivity` now lists the account's
most-recently-pushed repos via `GET /user/repos?sort=pushed` (real-time, authoritative,
private repos included once authenticated — confirmed against a live response) and reads
each one's actual commit log via `GET /repos/{owner}/{repo}/commits?author=&since=` — the
real git history, not a search index. Live-verified against a genuinely current commit on
a real public repo (torvalds/linux, pushed the same day) with zero lag, and both new
endpoints (`/user/repos`, the per-repo commits endpoint) confirmed reaching GitHub's real
API and failing clean on a deliberately invalid token. `/search/issues` (PRs/reviews) is
unaffected and unchanged — issues/PRs are lower-volume, centrally-indexed objects without
this same documented async-indexing-lag problem, and its `author:` qualifier was already
confirmed to include private repos once authenticated, unlike commit search's own gap.

**GitHub's commit read now goes through GitHub's own official MCP server instead of a
hand-rolled REST call — a deliberately narrow pilot for a much bigger question, not a
rewrite of everything.** After watching the three real bugs above get hand-debugged live,
one at a time, the user asked directly: this product is going to connect hundreds of
tools, and hand-writing and re-debugging a bespoke REST integration for each one doesn't
scale — can MCP servers replace that? Researched before writing any code: GitHub operates
an official, remote, hosted MCP server (`https://api.githubcopilot.com/mcp/`, no
self-hosting, plain PAT auth) whose `list_commits` tool wraps the same real Commits API
this project's own fix just moved to — GitHub's own maintainers already had to solve the
exact lag problem found here. Several other already-connected tools also have official,
remote MCP servers (Linear, Notion, Atlassian/Jira/Confluence, HubSpot, Salesforce, Asana,
Airtable, Monday, Trello, Dropbox, Slack) — real future candidates, not touched this pass.
A third-party MCP *aggregator* platform (Composio and similar) was considered and rejected
for the same reason this project's own "Nango, considered and rejected" note already gave:
it would route real, sensitive credentials through an additional third party, against this
project's own read-only/data-boundary framing.

The non-negotiable boundary: MCP replaces only the "how do I call this vendor's API"
plumbing inside a connector's own client module — never a new place decisions get made.
The router (`selectRelevantSurfaces`) still decides which *surfaces* are relevant and for
how long, never raw MCP tool names, never handed to a model for open-ended tool selection
— a model never sees GitHub's own 80-tool catalog. `github.ts`'s own code calls exactly one
hand-picked, hardcoded, read-only tool name (`list_commits`) — never a write tool (GitHub's
server also exposes `create_issue`, `merge_pull_request`, and dozens more, none ever
called from anywhere in this codebase) — enforced by what code exists, never by trusting
the server to self-restrict. New shared module `mcpClient.ts` (`withMcpSession`,
session-scoped per call rather than reconnecting per tool call, and deliberately not
exposing `listTools()` or any dynamic discovery surface to callers, for the same reason)
is the reusable foundation any future MCP-backed connector builds on next, the same way
`genericConnection.ts` is already reused by every PAT-based one. Its pure `isError`/
content-array translation (`parseCallToolResult`) is unit-tested directly — the piece
genuinely new to this codebase, since every other connector here parses a plain
`res.json()` body, not an MCP result envelope.

Deliberately **not** migrated: repo discovery (`GET /user/repos?sort=pushed`, a direct,
real-time listing, never part of the lag bug) and PR/review search (`/search/issues`,
already confirmed to include private repos correctly, unlike commit search's own gap) —
both stay on the REST calls that already work. GitHub's MCP server also exposes
`search_commits` — deliberately not used, since it's backed by the exact same lagging
search index as `/search/commits` and would just reintroduce the bug through a different
transport. `github.ts` is therefore a genuine MCP+REST hybrid, not "fully MCP": MCP only
where it demonstrably fixes a real, already-found bug, not because using MCP was itself
the goal. Before writing any mapping code, `list_commits`'s real input/output schema was
pulled directly from GitHub's own open-source server implementation
(`github/github-mcp-server`'s `minimal_types.go`, fetched via `gh api search/code` once
generic doc-summary fetches gave conflicting answers) rather than assumed — it turned out
to mirror the REST Commits API's own nested `commit.message`/`commit.author.date` shape
exactly, so the existing mapping logic needed no changes at all, just a new transport
underneath it. New test coverage (`github.test.ts`, `mcpClient.test.ts` — 16 tests, none
existed for this connector before, despite three live-only-found bugs) covers the pure
mapping/translation logic against those real, confirmed fixture shapes.

One real, honest cost: `@modelcontextprotocol/sdk` v1 (the stable line — the newer split
`@modelcontextprotocol/client` package is still alpha, `2.0.0-alpha.2`, deliberately not
used yet) pulls in a heavier transitive dependency tree than this project's other
integrations — Express, Hono, cors, rate-limiting middleware, none of it exercised by a
client-only usage, since the same package still bundles both SDK halves in the v1 line.
No way around it for now short of hand-rolling the MCP wire protocol, which would be worse.
Live-verified the same way every other UNVERIFIED-with-a-real-account connector in this
project is: a deliberately invalid PAT run through the real, rewritten `getRecentGithubActivity`
reaches `api.githubcopilot.com/mcp/` for real and gets back a genuine
`"unauthorized: AuthenticateToken authentication failed"` from GitHub's own live MCP
infrastructure — not a network/TLS/malformed-request failure, real proof the transport and
auth wiring are correct. A full round trip with a real PAT (confirming a real, current
commit lands in both the org path's claim and the personal path's `ask-personal` answer,
the concrete regression test for the bug that started this whole thread) remains
unverified for the same honest reason every other new connector in this project does;
update this note once one happens. If this pilot holds up under real use, the same
`withMcpSession` pattern is the template for the tools listed above next — not attempted
in this same pass, on purpose.

**Batch 2 of the MCP rollout — Notion, GitLab, and Linear — landed with genuinely
different confidence levels per tool, on purpose, rather than uniform treatment.** Asked
for directly right after the GitHub pilot: why not migrate everything, since a vendor
changing their own REST API underneath an *official* MCP server means the vendor updates
it, not this codebase. True, but conditional on "official" — a *community*-maintained
server carries the opposite risk (dependent on a volunteer keeping pace with a vendor's
changes, worse than owning the code directly), so each tool got checked individually
before being touched, not assumed. Real findings, ranked by how verifiable each one turned
out to be:

- **Notion** — had the strongest case of the three on paper (open-source server, confirmed
  thin passthrough of Notion's own REST API, `post-search`'s name and request schema
  verified directly against real source, not guessed), and was the first of this whole
  MCP effort to get a real, live test against a genuinely connected account — which is
  exactly what caught a real problem the paper case couldn't: `notion.ts` has since been
  **reverted back to plain REST**, not left on MCP. A real, fully-configured integration
  (page shared, every relevant capability enabled) still got a genuine
  `403 {"code":"restricted_resource","message":"Endpoint unavailable."}` from Notion's own
  MCP server specifically — not a code bug, not a missed setup step, most likely Notion AI
  access gating the `search` capability over MCP beyond what a plain internal-integration
  secret's normal capabilities grant. See `notion.ts`'s own module comment for the full
  story. Confirming this exact error was itself only possible after finding and fixing a
  real, unrelated production gap: this deployment's Fastify logger was configured
  `logger: false`, which silently swallowed every `app.log.error(...)` call in the whole
  codebase, not just this one — `railway logs` had never shown a single request-level log
  line, for any endpoint, until that was fixed to `logger: { level: 'warn' }`. A second,
  smaller fix landed alongside it: `ask-personal`'s digest bridge used to silently drop a
  connector that *errors* (as opposed to one that succeeds but finds nothing), reproducing
  the exact same "zero signal → false denial" bug the empty-digest fix had already closed
  for a different trigger — a rejected `fetchDigest` now gets the same honest, specific
  section the empty case does, never the raw error text itself.
- **GitLab** — real, sourced findings, not full certainty. GitLab's own docs
  (`docs.gitlab.com/user/model_context_protocol/mcp_server_tools/`) name the exact tool
  (`list_merge_requests`) and confirm its real filter parameters, but describe the
  response only as "compact metadata" without publishing exact field names, and the live
  server requires real auth even for `tools/list` — so the mapping keeps this file's
  existing REST-convention field names as the best-informed guess (GitLab's own REST API
  already uses exactly this snake_case shape), not a confirmed one.
- **Linear** — the weakest evidence, and shipped anyway as a deliberate, informed choice,
  not an oversight. Linear's MCP server is closed-source, its docs publish no tool
  reference, and — same as GitLab — the live server requires real auth even for
  discovery. `list_issues` and its `assignedToMe` filter come from third-party
  documentation of *unofficial* community Linear MCP servers, not a source confirmed to
  describe Linear's own official one. `linear.ts`'s parsing tries several plausible field
  spellings per value rather than assuming one exact shape, and degrades to an empty
  digest rather than fabricating data or crashing if the guess is wrong.

All three keep their identity/connect-time validation on their original REST/GraphQL
calls, unchanged — same reasoning as `github.ts`'s `fetchGithubLogin`: not part of what
this migration addresses, and it means "connect a token" still works even if a tool's MCP
path has a bad day. Live-verified the same way as the GitHub pilot: a deliberately invalid
credential for each of the three reaches its real, live, hosted MCP endpoint
(`mcp.notion.com`, `gitlab.com/api/v4/mcp`, `mcp.linear.app`) and gets a clean, real
rejection — Notion's and Linear's own native error shapes came through intact, proving a
genuine passthrough in both cases. A real end-to-end round trip with real credentials
remains unverified for all three, the same honest gap `github.ts`'s own commit read still
carries — and, explicitly, Linear should be the first of the three re-verified once a real
account exists, since it carries by far the least real evidence backing it.

**A connector that genuinely errors during a personal ask used to reproduce the exact
same "zero signal → false denial" bug the empty-digest fix already closed — just for a
different trigger.** Found live, immediately during Batch 2's first real test: a real,
freshly-connected Notion integration with real, freshly-shared page access still got "I
don't have access to your Notion account" from the model. The empty-digest fix only
covers a *successful* call that finds nothing; a call that genuinely *throws* (a wrong
tool name, a real provider outage, any bug in that connector's own code) was still
silently logged and dropped in `ask-personal`'s digest bridge, leaving `converse()` with
zero signal the tool was ever connected — same blind spot, different cause. Fixed the
same way: a rejected `fetchDigest` now gets the same honest, specific section as the
empty case ("Connected — reads: X. Checking it just now failed with a real error..."),
never the raw error text itself (that stays server-side, in the log call right after it),
and still counts as consulted, since it genuinely was checked. This also surfaced the
real diagnostic blocker for the Notion investigation itself: this deployment's Fastify
logger isn't wired to stdout in a way `railway logs` captures at all (confirmed live —
every request across every endpoint, not just this one, produces zero log output beyond
the startup banner), so there was no server-side way to see what actually failed. The
root cause turned out to be one line: `Fastify({ logger: false, ... })` — Fastify still
hands back a working `app.log` interface when logging is disabled, so every
`app.log.error(...)` call in this file (including the one right next to this fix) was
silently doing nothing, not throwing, not warning, just quietly swallowed. Fixed to
`logger: { level: 'warn' }` — keeps the default noisy per-request info logging out of
production, while making every real `.error()`/`.warn()` call actually reach stdout,
which is what Railway's log capture reads from. Both fixes landed together: the honest
chat-visible error (works even for a failure this specific logging gap would have hidden
regardless) and the actual logger fix (so the next investigation doesn't need to lean on
that alone).

Each org can also bring its own provider credentials instead of sharing this deployment's
platform-wide `ANTHROPIC_API_KEY`/`OPENAI_*` env vars — real multi-tenant flexibility for
different organizations on different LLM providers, including their own self-hosted/
open-source model. Optional `api_key_encrypted`/`base_url`/`model` columns on
`org_main_agent` (same admin-only endpoint, `apiKey`/`baseUrl`/`model` in the POST body)
override the platform default just for that org; all-null (the default) is exactly the
original behavior. The key is encrypted at rest — `backend/src/domain/crypto.ts`,
AES-256-GCM keyed by a new `CREDENTIAL_ENCRYPTION_KEY` env var (one per deployment,
required only once an org actually sets its own key) — and never leaves the server
decrypted; `GET .../main-agent` exposes only `hasCustomApiKey: boolean`, never the key
itself. `runtimeProvider.ts`'s `getMainProvider` resolves and binds the credential once
per ask (`resolveCredentials`/`bindCredentials`), so none of the 5 existing call sites
(`server.ts`'s `/api/agent/ask`, `realClaims.ts`'s 4 ingestion functions) needed to
change. The `llama-local` catalog entry is the generic "bring your own self-hosted
endpoint" vehicle — its copy is deliberately vendor-neutral (it used to describe one
specific on-prem box) since `runtime_catalog` is global, shared by every org. Real, typechecked/tested (round-trip encryption, credential-resolution fallback), and now
live-verified against a real, independent Anthropic API key: a genuine self-serve-signup
org (4 people, its own admin, no relation to the seeded Northbeam org) set its own key via
this exact flow, pushed one real activity event, and asked a real question — both the
claim-writing and the answer-synthesis steps came back as real Claude prose, not a
fallback, proving the org's own key (not any platform-wide env var, since that deployment
has none set) was genuinely what answered. `GET .../main-agent` was re-confirmed to never
return the key in any form. Still open: two *different* real organizations using two
*different* real providers side by side in the same deployment hasn't been exercised yet.
Its `base_url` is the one place this app ever fetches a URL an org admin
supplied itself — `backend/src/integrations/urlSafety.ts`'s `isSafeExternalUrl` blocks
private/loopback/link-local ranges and internal hostnames before it's ever stored *and*
again at fetch time (DNS can change between save and use), found and closed during a
security audit alongside the other findings below.

A full-app security audit (six pillars: auth/session, authz/multi-tenant isolation, input/
output handling, secrets/crypto, API/integration, AI-LLM specifics) found and fixed 12
issues, live-verified against the real deployment, not just read in code. The most
significant: `POST /api/query` returned the org's *entire* evidence table on every call
— including fully unauthenticated ones — regardless of what `respond()` actually
authorized; now scoped to only the evidence its own response items reference. Both
`/api/query` and `/api/agent/ask` also let an unauthenticated caller claim any role about
any person via `persist:false` ("preview" mode) with no relationship check at all;
`/api/agent/ask` now verifies unconditionally (no real caller ever used the bypass),
while `/api/query`'s preview requires either a genuine self-preview (`requesterId ===
targetId`) or a real org viewer+ role — since `PolicyMatrix.tsx`'s admin policy-testing
panel and `Preview.tsx`'s self-service "what would X role see about me" both depend on
bypassing role-*truthfulness* on purpose, just not on being a real caller. Three read
endpoints (`/api/overview`, `/api/escalations` GET, `/api/connections`) were completely
unauthenticated, gated only by a guessable `orgId` query param — now `requireOrgRole`
'viewer'-gated like `/api/audit` always was. Three siblings that look identical at a
glance (`/api/org`, `/api/policy` GET, `/api/audit/subject/:id`) are **deliberately left open server-side** (superseded 2026-09-12: all three are now
session-gated — the release audit confirmed live they leaked rosters and full disclosure
history to anonymous callers) — at the time of this audit, real self-service endpoints (`WhoAsked.tsx`,
`Ask.tsx`, `MyAgent.tsx`, `OrgStructure.tsx`, and `MeContext.tsx`'s then-free switcher)
depended on reaching them without a session, so gating them would have broken real
functionality, not closed a gap. That's narrower now than when this was written — "My
agent" overall requires a real login before any of these pages ever mount (see rule 7 and
the step-up-auth paragraph below) — but the endpoints themselves stay open rather than
newly gated purely on principle: re-verify every real caller before changing this, the
same caution that already caught three false positives once. Also
fixed: escalation acknowledge/resolve and `/api/agent/conversations` now prefer the
session's own linked identity over a client-asserted one (the same pattern `/api/agent/
ask` already used, factored into `sessionPreferredPersonId`); linking an *existing*
account into a new org's chart by email now notifies that account
(`sendAddedToOrgEmail`) instead of happening silently; Postgres connections negotiate TLS
against anything that isn't `localhost` (`db/sslConfig.ts`); `change-password` is rate-
limited like login; `@fastify/helmet` is registered; the session cookie's TTL dropped
from 30 to 7 days (true idle-timeout/sliding renewal is real, larger follow-up work — it
needs `reply`, not just `req`, threaded through every session check to also refresh the
cookie's own client-side expiry, not only the DB row).

Real per-person accounts and multi-org membership are built — one `accounts` table is the
login for everyone, admin or employee or both; the same account can administer several
orgs and be a person in several orgs at once (two independent facts, `org_admins` and
`people.account_id`, never conflated). Adding someone with an email (an org-admin invite,
or a person added to a chart) also emails them their one-time temp password when
`RESEND_API_KEY` is configured (`integrations/resendEmail.ts`) — not yet live-verified,
see "Where to go next" — and always still shows it once in the inviting admin's own UI
regardless, so nothing about the invite depends on email working. A fresh login always
lands on "My agent" regardless of role — see the step-up-auth paragraph below for why
Admin stopped being a default landing at all. What none of this does yet is change what
any individual *request* is trusted to say about its own identity — see "Where to go
next" and rule 7.

**Jira and Notion are live-verified now — both only after a real account was pointed at
them, and both found something no amount of code review would have.** Worth recording
together because they're the same lesson twice: this project's "the request shapes follow
the vendor's documented API exactly, and invalid credentials fail cleanly" standard is a
real check, and it is *not* verification.

- **Jira** had been marked UNVERIFIED-but-carefully-built since 2026-08-17. The first real
  connect failed outright: Atlassian had **removed** `POST /rest/api/3/search`, the endpoint
  this connector was written against, and returned a clean `410` naming
  `/rest/api/3/search/jql` as its replacement. Every prior check had passed precisely
  because they were all shape checks — the request was well-formed and the credentials were
  invalid, so a 401 was indistinguishable from a healthy connector. Migrated (same
  `jql`/`fields`/`maxResults` body, same `issues[]` response shape, `nextPageToken`
  pagination that this connector never needs since it fetches one page of 25),
  `/rest/api/3/myself` untouched since it was never deprecated, and the same person then
  confirmed a real ask answered from their real issues.
- **Notion** is verified on **plain REST**, which is the interesting half: the same real
  workspace and the same integration secret got a genuine
  `403 restricted_resource` from Notion's own MCP server and real pages back from REST.
  That's what makes the MCP-vs-REST comparison in `notion.ts` evidence rather than a guess.

Finding the Jira 410 at all depended on a fix made minutes earlier: `server.ts` was
constructed with `Fastify({ logger: false })`, which still hands back a working `app.log`
object, so every `app.log.error(...)` in the codebase had been silently discarding
everything for the life of the deployment. Two independent connector investigations stalled
on "the UI says it failed and the server says nothing at all" before that was traced. A
deployment whose error logs go nowhere doesn't have a connector problem, it has an
observability problem wearing a connector problem's clothes.

That lesson is now a command rather than a paragraph: `cd backend && npm run
check:connectors` (`scripts/check-connector-endpoints.ts`) sends a deliberately invalid
credential to the **read** endpoint of every connector on a fixed, public host and reads
the *status code* as the signal — `401/403` means alive and rejecting, `404/410` means the
endpoint is gone, which is precisely the Jira failure mode nothing here could previously
see. It checks reads rather than identity on purpose: Jira's `/rest/api/3/myself` kept
working the entire time the connector was broken, so an identity check would have reported
everything healthy. Per-tenant hosts (Jira, Confluence, Zendesk, Airflow, Snowflake,
Databricks, self-hosted GitLab) have no fixed URL to probe and still depend on a real
connect. First real run, from production: **14/14 alive, nothing else has rotted.**

**Run it from the deployed container, not a laptop** — `railway ssh 'cd /app/backend &&
npx tsx scripts/check-connector-endpoints.ts'`. Found immediately: `api.githubcopilot.com`
(GitHub's MCP server, which backs the commit read) resets every connection from this dev
machine while `api.github.com` from the same machine is fine, so locally it looks exactly
like GitHub deleted the endpoint. From production the same request returns `401
unauthorized: AuthenticateToken authentication failed` — completely healthy. A network
failure in that script is a claim about your egress until it reproduces somewhere that
serves users. (Also worth knowing: GitHub's MCP server 400s on a malformed Authorization
header *before* evaluating the credential, so it has to be probed with something PAT-shaped
to get the meaningful 401 instead of a shape complaint.)

`resourceProviders.ts`, `jira.ts`, and `notion.ts` all carry their real status now. Still
genuinely UNVERIFIED and unchanged: github's MCP-backed commit read, linear, confluence,
asana, gitlab, hubspot, zendesk, calendar, airflow, dbt, snowflake, databricks.

**Every outbound call has a deadline, and the fan-outs that multiply them are bounded (release
audit OPS-04, 2026-09-12).** No call to a connector, a model provider or Resend had a timeout, so
one hung vendor held a request open indefinitely and ask-multi multiplied it by every person and
tool. `integrations/outboundHttp.ts`'s `installOutboundTimeout` wraps the global `fetch` once at
startup (20s, `OUTBOUND_TIMEOUT_MS`), covering all ~24 connector modules and the MCP SDK
transport with no per-file changes. The default is *combined* with any signal a caller passes,
because SDKs pass signals that never fire: the MCP transport sends its session AbortController's
signal on every request, so a wrapper that deferred to "any signal" left those calls with no
deadline at all — found only by proving it against a server that accepts and never answers (hung
past 8s before, 2.1s after). Code that needs a different limit uses `deadline(ms)` (the
OpenAI-compatible call: 90s; Resend: 15s), which the wrapper leaves alone. The Anthropic SDK gets
`originalFetch()` and its own `timeout: 90_000, maxRetries: 1` (its defaults were 10 minutes and
2 retries); proved that through the wrapped fetch it would have been cut to the 20s default. MCP
sessions are capped at 45s end to end, Fastify's `requestTimeout` is 120s, ask-multi runs 4
people at a time, and per-person connector reads plus the personal digest bridge run 6 at a time
(`mapWithConcurrency`/`settleWithConcurrency`).

**CI runs on every push to `main`, `prod`, `qa` and `dev` and on pull requests (release audit
OPS-03, 2026-09-12)** — `.github/workflows/ci.yml`: backend typecheck, unit tests and production
dependency audit; every `*.api.test.ts` suite against a Postgres 16 service on the compose port;
frontend typecheck, tests, build and audit. Two things it can't enforce by itself (see "Where to
go next"): Railway's "Wait for CI" setting, and branch protection.

**Errors are tracked: request IDs, structured logs, a crash screen and browser reports, with
Sentry ready to switch on (release audit OPS-06/OPS-09, 2026-09-12).** Every response carries
`x-request-id` (a caller's well-formed ID is kept, otherwise a UUID). A server failure returns
only `{ error: 'internal server error', requestId }` and logs one JSON line on stderr
(`integrations/errorReporting.ts`: source, request ID, method, route *pattern* — never the raw
URL — status, error and stack), readable in Railway's logs; 4xx rejections aren't logged as
errors. The frontend wraps the app in `components/ErrorBoundary.tsx` (a crash screen instead of a
blank page) and reports render crashes, uncaught errors and unhandled rejections through
`lib/errorReporting.ts` (deduplicated, at most 10 per page) to `POST /api/client-errors` — open to
anonymous and unverified sessions on purpose, rate limited (20 per 5 minutes per IP), bounded by
schema, and logged the same way. Invitation, verification and reset tokens live in URL paths, so
they're redacted in the browser, again in the log line, and again in every Sentry event. Server
errors shown in the UI include "Reference: <request ID>". Setting `SENTRY_DSN` on Railway turns
on Sentry with no code change: one Node project receives both server errors and forwarded browser
reports, so no Sentry code ships to users' browsers; it's configured with no default
integrations, no default PII and no tracing, so it only ever sends what this module passes it.
`/?debugCrash` throws during render in a Vite dev build only (stripped from production; checked).
Guarded by `src/observability.api.test.ts` (9) and `errorReporting.test.ts` (4, including a
capturing Sentry transport proving events really send with a DSN and never without),
mutation-tested: leaking the error message in a 500, dropping redaction, and dropping the request
ID header each fail. Also fixed alongside: a query-string `orgId` above int4 returned 500 from the
database; it's now treated as no org (403).

**Schema changes are numbered migrations, applied automatically before every start
(release audit OPS-01, 2026-09-12).** The old `backend/db/schema.sql` could only `DROP SCHEMA`
and rebuild, so each production change was a one-off script run by hand over `railway ssh` —
and one of them was simply never run: production turned out to be missing
`account_custom_agents` (custom sub-agents shipped with no table behind them in production),
found only because the new runner's pre-deploy check refused to adopt a partial schema. It was
created with the original idempotent script before the runner shipped. Now:
`backend/db/migrations/NNNN_name.sql`, applied in order by `src/db/migrations.ts`, each in its
own transaction, recorded with a SHA-256 checksum in `schema_migrations`. A Postgres advisory
lock serialises concurrent starts; an applied file that has since changed, or a recorded version
with no file, stops the run. `npm start` is `node dist/migrate-up.js && node dist/server.js`,
using `DATABASE_ADMIN_URL`, so a deploy can't serve code ahead of its schema — and a failed
migration keeps the new server from starting, so **dry-run anything risky against a copy
first**. A database that had the full schema before the runner existed (production, long-lived
dev databases) is *adopted*: every baseline table and key column is checked, then `0001_baseline`
is recorded as applied without re-running; a partial schema is refused. `scripts/migrate.ts` is
now the dev/test reset only (same real-data guard, then drop and apply every migration). The
hand-run `migrate-add-*.ts` scripts were deleted; `migrate-encrypt-credentials.ts` stays (it
migrates data, not schema). Guarded by `src/db/migrations.api.test.ts` (9 tests on a disposable
database), mutation-tested: accepting an edited migration, adopting a partial schema, and not
rolling back a failed migration each fail the suite.

**External text reaching a model prompt can't break out of its data block, and pushed activity
is bounded (release audit SEC-14, 2026-09-13).** `wrapUntrustedData` (`modelProvider.ts`) used to
wrap raw text in `<label>` tags with nothing stopping that text from containing `</label>` itself,
which ended the block early and turned whatever followed into instructions. It now neutralises
every known label tag inside the content (`UNTRUSTED_LABELS`, spacing/case tricks included — add a
new label there, the type enforces it) and caps each block at 24,000 characters with a visible
"… omitted" note. Previously-unwrapped inputs are wrapped too: earlier chat turns
(`formatPriorTurns`, `conversation-so-far`) and the router's tool listing (`connected-tools` — a
custom agent's name and purpose are user-typed). A person's name goes into instruction text, so
both adapters pass it through `safePromptName` (one line, no angle brackets, 80 chars). On the
ingest side (`eventIngestion.ts`): a summary is flattened to one line with control characters
removed (a multi-line summary could fake extra digest bullets) and capped at 500 characters; an
unparseable `occurredAt` becomes now, and a future one is clamped to now so it can't dodge the
90-day cleanup; a digest lists at most the latest 200 events and counts the rest.
`POST /api/ingest/:source` is rate limited to 120 a minute **per token** (keyed on the token's
hash), so a leaked token can't flood from many addresses. Tests: `promptSafety.test.ts` (including
the prompt the OpenAI-compatible adapter actually sends), `eventIngestion.test.ts`,
`ingest.api.test.ts`; 11 mutations (each protection removed in turn) all fail the suites. Not
covered by a test: the Anthropic adapter's own `safePromptName` calls (same change, applied by the
same script as the tested adapter).

**Plan limits live in one file, and are enforced in one transaction (2026-09-17).**
`backend/src/plans.ts` is the single place to change them: `PLAN_SEATS` (starter 10, business
200, enterprise `null` for unlimited — `null`, never `Infinity`, which JSON turns into `null`
anyway) and `MAX_ORGS_PER_ACCOUNT` (5). Nothing else in either package hardcodes a number;
`GET /api/organizations` reports each org's own `seatLimit` so the UI renders "7 of 10 people"
and disables Add from real state rather than a copy of the rule. Verified as a single edit:
changing starter to 4 in `plans.ts` alone kept every test green, because the tests derive their
expectations from the constant too.

Enforcement is `repo.createPersonWithinSeatLimit` — count and insert in one transaction, behind
`pg_advisory_xact_lock(hashtext('org-seats'), orgId)` — and a 402 with a plain message naming
the plan and its limit. The lock is advisory rather than `SELECT ... FOR UPDATE` on the
organization row on purpose: row-locking needs an UPDATE grant, and `mesh_app` deliberately has
only SELECT and INSERT on `organizations` (0001_baseline), so taking that lock would have meant
granting the runtime role the ability to rewrite any org's plan and name. The first version
checked then inserted with nothing in between; proved on a warmed pool that 12 simultaneous
adds put **21 people in a 10-seat org**, and that the lock reduces it to exactly one. A second
sidestep is closed alongside it: without a cap on organizations per account, a company just
splits itself across free orgs — `POST /api/organizations` now refuses past
`MAX_ORGS_PER_ACCOUNT` (signup's automatic first org counts, and the cap counts owner rows
only, so being invited as an admin elsewhere never consumes it).

Guarded by `planLimits.api.test.ts` (5); mutations — dropping the lock, the seat check, and the
org cap — each fail it. **The concurrency test needed two corrections before it guarded
anything, both worth knowing for the next one.** Connections are opened lazily, and a cold
handshake takes far longer than an add's few round trips, so "parallel" requests each finished
before the next connection was ready and every one of them read an up-to-date count: with the
lock removed, the suite stayed green. Warming the pool first fixed that, but through
`app.inject` the route's own session and role lookups still stagger callers by milliseconds, so
the mutation only raced sometimes — a flaky guard is not a guard. It now calls
`createPersonWithinSeatLimit` directly on a warmed pool, which is deterministic: three runs with
the lock and three without, same result every time. Also removed: `repo.createPerson`, which had
no callers left after this change and was an unguarded second way into the same table.
Production was checked before deploying the caps — no org was near 10 people and no account
owned more than 2 orgs, so neither cap locks an existing org out. Not built: self-serve upgrade
(plans still change only by a manual database update), and no grandfathering for an org that
somehow ends up over its limit — it simply can't add until it's back under.

**A bell in the top bar says when someone asked about you (2026-09-13).** Notifications aren't
stored: they're the `audit_log` rows where someone *else* asked about one of this account's own
people, across every org it belongs to (`repo.listAskedAboutYou`) — the same rows "Who asked
about me" already shows the subject, so nothing new is disclosed. The only new state is
`notification_reads` (migration 0003: one `seen_through` per account). `GET /api/notifications`
returns the latest 20 plus an unread count; `POST /api/notifications/seen { through }` marks read up
to the newest item the person actually saw (never "now", so an ask landing while the panel is open
stays unread), never moves backwards (`GREATEST`) and never past the database clock (`LEAST(…,
now())`). `components/NotificationBell.tsx` polls once a minute while the tab is visible, refreshes
on becoming visible, clears the badge on open, and each entry opens "Who asked about me" in that
entry's org. Shown only to accounts with an org-chart identity (a personal-only account can't be
asked about). Wording helpers live in `lib/notifications.ts` ("Marta Vieira asked about you, as an
executive", "5 min ago"). Tests: `notifications.api.test.ts` (7), `lib/notifications.test.ts`;
6 mutations (unscoped to own people, self-asks included, uncapped or backwards read marker, count
ignoring reads, no login check) all fail the suite. Checked in a real browser at desktop and 400px
widths. Not built: email or push delivery, and escalations in the same bell.

**First run is guided, and the employee-facing screens speak plainly (2026-09-13).** Found by
signing up a brand-new account and screenshotting every screen, not by reading code. Changes:
- **A real honesty bug, fixed first.** Controls' "Cycle" button (`POST
  /api/person/:id/surface/cycle`) turned a tool from *not connected* to *connected* with no
  credential, so anyone could make coverage look complete and requesters' answers named tools
  that were never read. It's now pause/resume: `nextSurfaceState(current, hasRealConnection)`
  pauses any active state to `absent`, and resumes only when a stored credential (the person's
  `STATUS_HANDLERS` entry) or, for push-based tools, a pushed event exists; otherwise 409 "Connect
  it in Set up my agent first". Golden tests in `coverage.test.ts` changed deliberately;
  `surfaceControls.api.test.ts`; 4 mutations caught.
- **"Get started" checklist** on My agent (`components/GettingStarted.tsx`, logic in
  `lib/gettingStarted.ts`): choose the AI that answers, connect a tool, ask a first question, and
  (admins only) add your team. Every tick is derived from real data; it vanishes when all are done;
  "Hide" is per browser. Non-admins are told an admin chooses the agent. `lib/navigate.ts` lets a
  page change screens through Shell's existing popstate routing.
- **Landing page** lists only connected tools instead of 24 rows of `absent`/`outOfScope`.
- **Coverage sentence** (`policy.ts`): "Checked 3 of 8 tools (38%). Missing: Slack, Jira (out of
  date). Nothing was guessed to fill the gaps." Every gap is still named; the word "Missing" must
  stay because `server.ts`'s `silentGaps` counter (and older stored answers) depend on it — pinned
  by a golden test.
- **Labels:** T1/T2/T3 badges read From records / From activity / Unconfirmed; WONT/CANT read
  Withheld / Never collected (still visibly different, rule 4). "Surfaces", "aggregator", "claims",
  "requester", "audit" removed from employee screens; the org agent panel offers owners/admins a
  "Choose the AI" button instead of "your admin hasn't set one".
- **Demo leftovers removed:** hardcoded Confluence/Salesforce text on What it knows; "Northbeam
  tenant" hosts and "Org default. Enterprise agreement…" in the shared runtime catalog (seed +
  migration 0004); Who asked about me's empty state wrongly said your own asks appear there.
Not yet reworded: Admin screens (Overview, Policy matrix, Coverage matrix, Audit log), Preview's
intro, and OrgSetup.

**Launch ships seven tools, and each has to work end to end (decision 2026-09-14).** GitHub, Jira,
Linear, Claude Code, Codex, Notion and Google Calendar. Every other connector keeps its code but
is `status: 'coming-soon'` in `connectorCatalog.ts` until it's verified against real accounts;
the server refuses to connect them or accept pushes for them (404). An end-to-end test with real
Claude Code and Codex sessions (2026-09-13) found what this fixes:
- **Codex recorded nothing.** Codex's PostToolUse hook sends `tool_input.command` with no
  `description` and edits files with `apply_patch`; both were accepted (202) and discarded.
  `normalizeIngestPayload` now uses the command's first line (`Ran: …`, credentials masked by
  `redactSecrets`, 160 chars) and the file names from patch headers. Real payloads are fixtures in
  `eventIngestion.test.ts`. The app's Codex instructions point at `.codex/hooks.json` and say to
  git-ignore it (it holds the token; Claude Code's `settings.local.json` is ignored by default).
- **A push switched on a tool marked "not used for your role"**, and the content reached the
  manager's answer. The ingest route now refuses to record for an `outOfScope` tool, and a tool
  paused in Controls (`absent` with earlier events) stays paused. **Correction (2026-09-15):**
  that finding's premise was wrong for these tools. Nothing ever set `outOfScope`
  deliberately — `repo.ts`'s `EMPTY_SURFACES` simply defaulted Claude Code, Codex and Gemini CLI
  to it (in production, every `outOfScope` value was one of those defaults), so the refusal
  meant nobody in an organization could connect Claude Code or Codex. They now default to
  `absent`, migration 0005 fixed existing people, and the refusal only applies if a role is ever
  genuinely excluded. Found when a real owner asked about an employee who had connected Claude
  Code — which exposed a second problem: they'd connected it to their *private* agent, which the
  organization's agent can't read. The two look-alike tool panels on "Set up my agent" are now
  labelled by whose agent reads them, private tokens say the organization won't see the
  activity, and an ask about someone with nothing connected says so instead of "nothing is
  disclosable". The same real test showed every answer saying "1 item withheld": `allowedTextOnly`
  counted the standard never-collected (CANT) notice as withheld, which conflated the two (rule
  4). It now returns `withheldCount` (policy-withheld only) and `neverCollectedCount` separately,
  and the frontend's history reconstruction (`lib/conversations.ts`) matches. The fallback
  answers no longer say "No ANTHROPIC_API_KEY configured…": they say the organization's AI has no
  key (or none is chosen) and that an admin can fix it in Admin → Organizations.

**Ask chats can be removed from your own list, never deleted (2026-09-15).** Asked for as "delete
the conversation". A chat is a grouping of `audit_log` rows, which are append-only (rule 2) and
are exactly what the person asked about sees in "Who asked about me" — deleting them would let a
manager erase that they asked. So the × on the Ask page's chat list (which now shows every chat
with anyone, labelled by person — `GET /api/agent/conversations/mine`) calls
`DELETE /api/agent/conversations/:id`, which only records the choice in `hidden_conversations`
(migration 0006, SELECT/INSERT only) for the person who asked. Both chat-list queries skip hidden
chats; the audit rows, "Who asked about me" and the admin audit log are untouched, and the
confirmation says so. Only the asker can hide their own chat about someone else (`repo.
hideConversation` checks); self-chats on My agent are unaffected. Tests:
`hideConversation.api.test.ts`, `conversationsMine.api.test.ts`.
- **A failed model call dropped the claim**, so every asker, the subject included, was told
  "nothing is disclosable". `realClaims.claimText` saves the deterministic sentence instead.
- **Planted text was saved into a claim** (not obeyed, but repeated to the manager). The
  claim-writing prompt now excludes instructions and pay/performance/health/personal/leaving.
- **Full local paths** reached managers; paths are stored relative to the hook's `cwd`.
- **In local dev, answers read the developer's own Claude Code logs.** That scan now needs
  `CLAUDE_CODE_LOCAL_TRANSCRIPTS=1` (never in production).
Also: Google sign-in requests `calendar.readonly` only — Gmail's read scope is Google-restricted
(verification plus a paid security assessment), so Gmail is off and its answer bridge removed;
Calendar has its own Connect/Disconnect in the connect panel. The fake "(Simulated)" sub-agent
replies are gone. `GET /healthz` (database ping, no session) and SIGTERM graceful shutdown
(release audit OPS-05). Tests: `launch.api.test.ts`, `claimText.test.ts`, additions to
`eventIngestion.test.ts` and `promptSafety.test.ts`; 12 mutations (each fix removed in turn) all
fail the suites. **Still to do before calling the seven verified:** a real-account round trip in
production for GitHub, Jira, Notion, Google Calendar, Claude Code and Codex (the operator has those
accounts), with Claude and ChatGPT as the org agent. Linear has no real account available — its
MCP read carries the weakest evidence of the seven. The landing page still lists the non-launch
tools and mentions Gmail for the private agent; update it to match.

**New signups must verify their email, and anyone can reset a forgotten password by email
(2026-09-12).** Both use one-time links from `email_tokens` (`aov_`/`aor_` token, SHA-256 hash
at rest, single-use; issuing a new link of the same kind retires older ones; verification
lasts 24 hours, reset 30 minutes; a link dies if the account's email no longer matches the
address it was sent to). **Verification** is required only for accounts created by self-serve
signup from now on (`accounts.email_verification_required`): every account that already
existed stays usable rather than being locked out, and gets verified by a reset or an emailed
invitation. It's enforced in `server.ts`'s `preHandler` verification gate, not the UI: a
session whose account is pending gets 403 `email_unverified` from every `/api/*` route except
the short `VERIFICATION_EXEMPT_ROUTES` list (login/signup/logout/me, verify and resend, reset,
invitations, public catalogs, ingest). The frontend shows `VerifyEmailGate` instead of the app
(`pages/EmailLinks.tsx`), and `/verify-email/:token` works without a session, so the link can be
opened on another device. **Password reset** follows OWASP's Forgot Password guidance: the
request always gets the same answer, returned before the lookup and send happen, so neither
body nor timing reveals whether an account exists; it's throttled per IP and per address (3
emails an hour); confirming sets the password, spends every outstanding reset link, revokes
*all* sessions, and marks the email verified (receiving the link proves the inbox) in one
transaction (`repo.resetPasswordWithToken`). This is what closes the trade-off stated in the
invitations paragraph below: someone who registered a future employee's address first can no
longer block them, because the real owner resets the password from their own inbox, which
signs the squatter out everywhere, then accepts the invitation. Separately, an unverified account
can no longer accept an invitation that was only shared by hand (an emailed one proves the inbox
by itself). Tests read mail from `resendEmail.ts`'s in-memory `outbox`
(`EMAIL_TRANSPORT=memory`, ignored in production) and follow the real links:
`src/email.api.test.ts` (11 tests), mutation-tested — removing the gate fails 1, leaving other
sessions alive after a reset fails 2 (including the squatter scenario), reusable links fail 4,
letting unverified accounts accept a hand-shared invite fails 1, a reset response that reveals
whether an account exists fails 1. Production needed `scripts/migrate-add-email-tokens.ts` run
before the deploy.

**Adding someone by email issues a one-time invitation link; it never links or creates an
account (release audit SEC-08, 2026-09-12).** Before this, `POST /organizations/:orgId/people`
linked the new chart entry to whichever account already held the typed email, and
`POST /organizations/:orgId/admins` granted the role to it — so anyone who signed up early
with a future employee's address *became* that employee (or admin) the moment an admin
added them. Now both create an `invitations` row (random `aoi_` token, only its SHA-256 hash
stored, 7-day expiry) and return the link once to the admin (`OrgSetup.tsx`'s
`InviteLinkNote`), also emailing it when Resend is configured — production has no
`RESEND_API_KEY` yet, so today it's copied and shared by hand. `/invite/:token`
(`pages/AcceptInvite.tsx`, public but inside the auth providers) shows the invitation, lets the
person sign in or sign up with the email prefilled, then `POST /api/invitations/:token/accept`
binds it in one locked transaction (`repo.acceptInvitation`): the session's email must match
the invitation, the token is single-use, unexpired and unrevoked, a chart entry must still be
unclaimed, and an existing admin role is never downgraded. Admins list and withdraw pending
invitations (withdrawing an admin-role invite is owner-only, like issuing one). No temporary
password is issued on invite anymore; the admin-initiated password *reset* below still uses
one. `accounts.email_verified_at` is set only when an invitation that was actually emailed is
accepted — recorded, not required, until email works. Known trade-off, stated plainly: a
squatter who registers an email first can now *block* that invitation (the real person can't
sign in as an account they don't control) but can no longer *capture* it; the real fix is an
emailed password reset once Resend is live. Guarded by `src/invitations.api.test.ts` (11
tests), mutation-tested: restoring email-match linking fails 2, dropping the accept-time email
check fails 2, allowing reuse fails 1. Production needed `scripts/migrate-add-invitations.ts`
run *before* the deploy (the code selects `email_verified_at`). The "Adding someone with an
email ... also emails them their one-time temp password" sentence further down is superseded
by this paragraph.

**A temp password can no longer become someone's permanent one, and an admin can reset a
member's password without any email involved.** Researched before building (OWASP's Forgot
Password cheat sheet, NIST 800-63B, how Clerk/WorkOS model org invites); the email
reset-token half is deliberately deferred, see "Where to go next". The gap that made this
urgent wasn't the missing reset flow — it was that `POST /api/auth/change-password`
already existed, already rate-limited, with **no UI anywhere**: `api.changePassword` was
called from nothing, so anyone handed a temp password literally could not change it.

`accounts.must_change_password` marks a password its owner never chose — set by every
invite and by an admin reset, never by a self-serve signup (that password *was* chosen).
While it's true, `App.tsx`'s `Shell` renders `components/ChangePasswordModal.tsx` over
everything with no dismiss, and the modal locks body scroll (a `position: fixed` overlay
covers the viewport but does nothing to stop the page scrolling behind it — the app was
fully browsable underneath before that). The same modal, dismissible, is now reachable any
time from the profile menu. It's a UX forcing function, not a security boundary pretending
to be one: every other endpoint stays reachable, and the flag can only be cleared by
`change-password`, which requires proving the current password.

**Admin-initiated reset** (`POST /api/organizations/:orgId/people/:personId/reset-password`,
admin + step-up) issues a fresh one-time temp password shown once, flags the account, and
revokes every session it had. It **refuses for an account that also belongs to another
organization** (`repo.accountBelongsToOtherOrgs`) — the one genuinely load-bearing
decision here. An `accounts` row is a *global* login, not a tenant-owned identity (that's
the whole point of `people.account_id` not being unique), so unlike Google Workspace or
Microsoft 365 — where an admin can reset any user because those identities belong to the
tenant — minting a password for a cross-org account would hand this org's admin a working
login to someone else's org. That's a real cross-tenant takeover, not a theoretical one.
It also refuses for a chart-only person with no login, and for the caller's own account
(use "Change password").

Two smaller things landed alongside, both from OWASP's guidance: a successful password
change now revokes every *other* session for that account (the caller's own is spared, so
you aren't logged out of the tab you did it in — `repo.revokeOtherSessionsForAccount`),
and reusing the current password as the new one is rejected.

The reporting gap that started this is closed too: adding a person whose email **already
has an account** was already handled correctly server-side (link the account, issue no
credential, send an added-to-org notice), but the frontend gated its confirmation panel on
`tempPassword`, so that case rendered *nothing at all* — indistinguishable from the add
having failed. `api.addPerson`/`api.inviteOrgAdmin` now surface `linkedExistingAccount` and
`OrgSetup.tsx` reports either outcome explicitly. The admin-invite path also gained the
added-to-org notice it was missing entirely — only the add-a-person path had one, so being
granted an admin role on an existing account happened in total silence.

One real bug surfaced by the new endpoint and fixed with it: `StepUpContext` showed any
error thrown by the *retried* action inside the "Confirm it's you" box, as though the
password had been mistyped — a refused reset reported "Use Change password for your own
account" next to a password field. Auth failure and action failure are separated now; the
latter closes the prompt and rejects so the caller surfaces it where the action was taken.

Schema note, following the convention `schema.sql`'s own header sets: `must_change_password`
is declared there for fresh databases *and* was applied to the live database by hand as its
own additive `ALTER` (`backend/scripts/migrate-add-must-change-password.ts`, idempotent,
kept in the repo so what ran against production is reviewable), rather than loosening
`migrate.ts`'s destructive-reset guard. Applied to production *before* the code deploy,
since the new code selects the column — 16 existing accounts, none flagged. Reaching the
production database at all needs `railway ssh` (its Postgres has no public TCP proxy):
`railway ssh 'cd /app/backend && TARGET_URL="$DATABASE_ADMIN_URL" npx tsx scripts/migrate-add-must-change-password.ts'`.

Live-verified end to end against the running API and a real browser, not just typechecked:
an invite issues a flagged temp password; login reports `mustChangePassword`; reusing the
temp password as the new one is rejected; changing it clears the flag, keeps the current
session alive, and kills a second session opened beforehand; the old temp password stops
working; adding an already-registered email links instead of issuing a credential; and
reset is refused for cross-org, no-login, and self targets while genuinely working for an
org-local one, with the one-time password rendered in the admin UI.

**Self-serve signup creates a personal account *and* a one-person "workspace" org in the
same step — no separate "create an organization" click, no company name to type.**
`POST /api/auth/signup` takes just name/email/password; the org name is auto-derived
(`"<name>'s workspace"`) and the caller becomes both its owner-admin and its first person
(Owner, top of chart) atomically (`repo.ts`'s `createOrganization`, the one place an org
actually gets created — also used for an *existing* admin adding an additional org later).
The new session is elevated immediately on signup (typing your password to sign up already
proves it — see step-up below), so a brand-new owner can go straight to Admin →
Organizations and set their own main agent with zero extra friction. Accounts and
organizations are still decoupled *data-wise* — an account can in principle exist with
zero orgs (e.g. one only ever linked into someone else's chart by email) — and "My agent"
still detects that case (`App.tsx`'s `hasOwnIdentity`, `useAuth().people.length === 0`),
but it's no longer a dead-end fallback: it's a real, working personal main agent and
"Ask yourself" instead (see the personal-main-agent paragraph below) — no longer the shape
signup itself produces, but not a lesser experience either. This is the *third*
iteration of this flow in one day, each found live: bundled signup (one atomic step, but
skipped straight to an org-creation form with no individual-identity step first, unlike
every comparable product's onboarding) → fully decoupled, GitHub-style (asked for
explicitly, but made the common case — one person trying the product — file a company name
and pass a second re-auth prompt just to start) → this: signup still creates only what's
needed for *that* account, but does it in one step, because most people trying this out are
one person, not a company standing up a multi-person chart.

**A real login gates both "My agent" and Admin; step-up ("confirm it's you") is
action-scoped, not a gate on entering Admin at all.** `App.tsx`'s `Shell` no longer shows
Admin and "My agent" as co-equal tabs — "My agent" is the only thing shown by default.
Admin and logout both live under one profile menu (`App.tsx`'s `ProfileMenu`, opened by
clicking your own name/avatar in the topbar). Clicking "Admin" goes straight to the Admin
panel — reading Overview, Coverage, Audit log, Org structure, Connections, Escalations
needs nothing beyond the same login already proven, exactly like any other read. This
reverses the first version of this feature (a full-page password re-prompt gating *every*
visit to Admin), changed after research into how GitHub, Stripe, Google Workspace,
NIST 800-63B, and OWASP actually handle "logged in vs. elevated": none of them
re-authenticate on *entering* an admin area — GitHub's own sudo-mode docs describe it
triggering on specific actions (adding an SSH key, authorizing an OAuth app), never on
viewing settings; OWASP's guidance is explicitly action-scoped (a dedicated "Transaction
Authorization" cheat sheet); Google Workspace's admin console trusts the existing session
by default. Blanket re-auth on every entry is also the documented UX failure mode: it
trains people to treat the prompt as noise. Found live, reported directly, right after
shipping the original blanket version: "this login to admin system is not good."

Step-up now surfaces only when a specific sensitive write actually needs it — inviting or
removing an org admin, changing an admin's role, removing a person from the chart, setting
the org's main-agent credentials, editing the policy grid, and creating a brand-new
organization — the same set GitHub/Stripe reserve theirs for. `requireOrgRole` (server.ts)
takes an `{ elevated: true }` option now, opt-in per call site instead of an implicit
blanket rule; the ~7 calls above pass it, the rest (reads, and low-stakes writes like
adding a person to the chart) don't. `POST /api/organizations` (creating a new org, no
`orgId` yet to check a role against) still goes through the separate
`requireElevatedSession` it always used, unchanged. On the frontend, `StepUpContext.tsx`
replaces the old full-page `AdminStepUp.tsx` gate (deleted, not left as dead code) with an
inline modal any component can trigger: `runWithStepUp(() => api.someAction(...))` runs
the call normally, and only on a real `428` (a new `ApiError` class in `api.ts` now
carries the actual HTTP status, not just a message string, so this check isn't a fragile
string match) does it show a password prompt over whatever the person was already doing,
then retries the exact same call once, automatically, on success — never a full-page
redirect, never losing the form state around it. Live-verified end-to-end: Admin opens
straight to Overview with zero prompts; four different read screens confirmed prompt-free;
inviting an admin correctly triggers the inline modal without navigating away; a wrong
password is rejected with the modal staying open; the correct password closes it and the
invite completes automatically, no second click. Every one of the gated endpoints still
re-checks elevation server-side regardless of what the UI shows — this change moved where
the prompt appears, not the boundary it enforces. "My agent" itself still requires a real
login before rendering anything (see the MeContext.tsx layout entry above for why) — found
live when a real "Try it for free" click landed on a stranger seeing a named seeded
person's data with no login at all, which read exactly like a broken login rather than a
demo. One more race surfaced and got fixed along the way: `MyAgent.tsx`'s own
identity-loading effect had no stale-response guard, so a brand-new signup flipping from
the placeholder demo org to its own real org almost instantly could still end up
displaying the demo org's data if that slower request happened to resolve last — same
class of bug, same `cancelled` fix, as `Overview.tsx`'s own guard.

Multi-conversation chat, ChatGPT-style, is real on both "My agent" → "Ask yourself" *and*
the cross-person **Ask** page — switch between chats, start a new one, and a follow-up
question is answered with that chat's own prior turns as genuine context (proven live: a
pronoun-only follow-up like "how many days is that?" resolves correctly inside its chat
and correctly fails, honestly, in a new one with no context). Self-chat
(`requesterId === targetId`) and a real manager-asking-about-an-employee thread are the
same code path — `repo.listConversationsForPair(requesterId, targetId)` groups one pair's
own real, already-persisted `audit_log` rows, no parallel history mechanism, no new
storage. The one place they diverge: on Ask, the requester's claimed role can change
between turns in the same thread, and different roles are authorized to see different
claims (`domain/policy.ts`) — so prior-turn context is only fed into the model prompt when
the new question is asked under the *same* role as that stored turn (verified live: role
switched mid-thread → that turn's `priorTurns` came back empty). The thread itself still
*displays* every turn regardless of role — it's the requester's own real history, already
fully visible to them elsewhere, so nothing new is disclosed by showing it. See
`backend/src/server.ts`'s `POST /api/agent/ask`, `GET /api/agent/conversations`, and
`frontend/src/lib/conversations.ts` (shared, role-agnostic, by both `MyAgent.tsx` and
`Ask.tsx`).

Real tool-routing for "Ask yourself" is built — a self-ask decides on its own which of a
person's connected tools are actually relevant to *this* question and only reads those,
proven visibly rather than just claimed: `consultedSources` (`domain/types.ts`'s
`AgentResponse`, persisted in the audit snapshot like `synthesizedAnswer`) is real,
router-decided proof of which tools got called, shown under the answer in
`MyAgent.tsx`. Claude Code and GitHub already flowed through the existing
`resourceProviders.ts`'s `gatherAll` + router for any ask, self or cross-person — the new
piece is Gmail, which structurally can't go through that path (it must never become a
`claims`-table row a manager could see via cross-person Ask — see that file's module
comment). Instead it's a second, narrower, self-ask-only bridge directly in
`POST /api/agent/ask`: gated on `role === 'Self' && requesterId === targetId`, resolves a
live Gmail token, runs one more router call scoped to just `gmail`, and if relevant, feeds
a real digest into *that turn's* prompt only — never persisted as a claim, never reachable
from the cross-person **Ask** tab. `gatherAll` itself now returns which surface keys it
ingested (used to be fire-and-forget) so the caller has real data to build
`consultedSources` from. See "Where to go next" for the one still-unverified piece (a live
Gmail read).
