# Agent Org Mesh — working notes for Claude Code

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

7. **Login is real; per-request `personId`/`requesterId` still isn't — don't conflate
   them.** One identity table, `accounts` (`backend/src/domain/auth.ts` for password/
   session-token hashing, `db/repo.ts`, `server.ts`'s `requireOrgRole`) — a session
   cookie, not a client-asserted id, decides which account is logged in. The same account
   can hold an `org_admins` row (platform governance for an org) and/or be linked from one
   or more `people` rows via `people.account_id` (an org-chart identity, one per org,
   not unique — that's how one human ends up in more than one organization for real).
   **What logging in does *not* yet do**: change what any request is trusted to say about
   itself. `POST /api/agent/ask`'s `requesterId`, every self-service endpoint's `personId`
   (GitHub/Jira/Gmail connections, ingest tokens, sub-agent registration, claim correction —
   the org's one main-agent registration is the one exception, genuinely session-gated via
   `requireOrgRole` since it moved to an admin-only, org-level setting) all still take the
   id a request/the browser hands them at face value, even for a person now linked to a
   real, logged-in account. "My agent" itself is no longer one of these — its identity
   switcher (`frontend/src/lib/MeContext.tsx`) used to let any logged-in account freely
   switch to *any* person's view in *any* organization, not just its own; that's closed
   now, see the MeContext.tsx layout entry below. Closing the rest — making those
   endpoints prefer the session's own identity over a client-asserted one — is real,
   separate work (see "Where to go next"), not something signup/login accomplished by
   existing. Don't write code that treats a client-asserted `personId` as verified just
   because real accounts now exist.

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
backend/db/schema.sql tables + the mesh_app role + its grants (a full reset every run —
                       see the note at the top of the file; there's no prod data behind it)
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
cd backend  && npm run db:migrate    # apply backend/db/schema.sql
cd backend  && npm run db:seed       # load the seed.ts dataset into Postgres
cd backend  && npm run dev           # API on :3001, reads DATABASE_URL (defaults to
                                      #   the mesh_app role against the compose db)
cd frontend && npm run dev           # UI on :5173, proxies /api
cd backend  && npm test              # 162 golden tests — pure in-memory, no DB required
cd frontend && npm test              # 26 tests for pure lib/ logic — deriveAllowedRoles'
                                      #   client-side mirror, escalation status text,
                                      #   Ask-yourself chat-history reconstruction
```
Both `mesh_admin` (schema owner, used only by migrate/seed) and `mesh_app` (least-privilege
runtime role) credentials default to the values in `backend/db/schema.sql` /
`docker-compose.yml`; override via `backend/.env` (see `.env.example`) for anything else.

`npm run db:seed` prints a real dev login: `jordan@agentorgmesh.local` / `admin-dev-only`
(owner of the seeded Northbeam org). Not a secret worth protecting — this database is
thrown away and reseeded by that exact script. To try self-serve signup instead, use
"New here? Create your account" on the login screen with any new email — you land in your
own real, one-person org immediately, no separate org-creation step.

## Where to go next
- **Extend session-trust to the remaining self-service connection endpoints.** Rule 7 is
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

- **Verify the Jira provider against a real instance.** The connector itself is built —
  `jira.ts`/`jiraConnection.ts`, `ingestJiraClaim` registered in `resourceProviders.ts`,
  full connect UI in Set up my agent — same shape as GitHub's, down to the API-token
  pattern. But unlike every other connector in this project (Claude Code, GitHub, Codex
  CLI, Gemini CLI — all live-verified against a real account/instance/CLI, not just
  typechecked), there was no real Jira Cloud site available as of 2026-08-17. What *was*
  verified without one: input validation, and that invalid credentials fail cleanly
  (checked against a real but nonexistent Atlassian domain) rather than silently
  succeeding or corrupting surface state. The request shapes follow Jira Cloud's
  documented REST API v3 exactly, but nothing has round-tripped against a live site.
  Once there's a real instance: connect it for real, confirm a claim actually lands, then
  update this note and `docs/agent-to-agent-communication.md` to drop the UNVERIFIED
  language in `jira.ts`'s module comment and `resourceProviders.ts`.

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

- **Verify Notion's, GitLab's, and Linear's MCP-backed reads against real accounts —
  Linear first.** Same shape of gap as the GitHub pilot, but the three carry genuinely
  different amounts of real evidence behind them (see the CLAUDE.md paragraph on this
  batch for why): Notion's is the strongest (its server is open-source and confirmed to be
  a thin passthrough of Notion's own REST API — the existing parsing logic needed no
  changes at all), GitLab's rests on real documented tool/parameter names but an
  unconfirmed exact response shape, and Linear's rests on third-party documentation of
  *unofficial* community servers, not a source confirmed to describe Linear's own official
  one. All three: a deliberately invalid credential reaches the real hosted endpoint and
  fails clean, but no real round trip has happened. Verify Linear first when a real account
  becomes available, precisely because it has the least real evidence supporting it;
  update `linear.ts`/`gitlab.ts`/`notion.ts`'s own module comments and this note once each
  is confirmed.

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
registered into `resourceProviders.ts`'s `PROVIDERS`. Live-verified the same way Jira's
request shapes were — deliberately invalid credentials against each tool's real API,
confirmed each fails cleanly with a real provider-specific rejection and zero 500s — for
7 of the 8 (all but Calendar, which needs a live Gmail OAuth round-trip that remains
unverified for the same pre-existing reason as Gmail itself). No real account was
available for any of the 8, so — same as Jira/OpenAI/Gmail — a real successful
connect-then-ask round trip is still unverified; update this note once one happens.
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

- **Notion** — the strongest case of the three, stronger than expected. Notion's official
  MCP server is open-source (`github.com/makenotion/notion-mcp-server`) and, read
  directly, turned out to be an auto-generated thin passthrough of Notion's own REST API —
  the search tool's name (`post-search`) comes straight from the OpenAPI `operationId` in
  `scripts/notion-openapi.json`, and its request schema matched this file's own existing
  request body field-for-field. `getRecentNotionActivity`'s parsing logic needed zero
  changes, same pleasant surprise as `github.ts`'s commit mapping. One more thing
  genuinely confirmed live, not assumed: whether the hosted endpoint even accepts this
  connector's existing credential (Notion's own "internal integration secret," not a
  personal OAuth login) — it does; a deliberately invalid secret produced Notion's own
  real REST API error shape through the MCP endpoint, proving a genuine passthrough.
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
glance (`/api/org`, `/api/policy` GET, `/api/audit/subject/:id`) are **deliberately left
open server-side** — at the time of this audit, real self-service endpoints (`WhoAsked.tsx`,
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
