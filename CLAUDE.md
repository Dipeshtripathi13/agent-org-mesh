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
two independent facts about the same login, not two account types. Anyone can self-serve
create a brand-new organization from scratch (`/auth/signup`, "New here?" on the login
screen) — no existing admin has to set it up for them first. Everything an org actually
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
   `requireOrgRole` since it moved to an admin-only, org-level setting),
   and "My agent"'s free identity switcher (`frontend/src/lib/MeContext.tsx`, still open
   by design) all still take the id a request/the browser hands them at face value, even
   for a person now linked to a real, logged-in account. Closing that — making those
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
                       `signUpWithNewOrganization` is the one atomic self-serve-signup
                       transaction (account + org + first person + owner row together).
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
                       `login`/`signUp`/`logout`. `Shell` in App.tsx renders
                       `pages/Login.tsx` (which itself can hand off to `pages/SignUp.tsx`)
                       in place of the whole Admin panel whenever there's no session.
frontend/src/lib/MeContext.tsx  React context for the My-agent panel's "who am I" — a
                       free identity switcher (org + person) that still works fully
                       logged-out (rule 7), but now defaults to your own real identity/
                       identities from AuthContext's `people` the moment you do log in —
                       a better default, not a lockdown; the switcher itself is unchanged.
frontend/src/pages/OrgSetup.tsx  Admin → Organizations: create an org (or self-serve via
                       `pages/SignUp.tsx`), build its chart person by person — optionally
                       with an email that resolve-or-creates a real login for that person,
                       the same one-time-temp-password pattern as inviting an org admin
                       (and ingest tokens before that) — and manage which real accounts
                       (owner/admin/viewer) administer it.
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
"New here? Create your organization" on the login screen with any new email.

## Where to go next
- **Extend session-trust to the remaining self-service connection endpoints.** Rule 7 is
  now mostly closed, not mostly open — updated after a full security audit fixed the
  worst of it. `POST /api/agent/ask` and `POST /api/query`'s `requesterId`, escalation
  acknowledge/resolve's `actorPersonId`, and `/api/agent/conversations`'s `requesterId`
  all now prefer the logged-in session's own linked person-identity over a client-asserted
  one (`sessionPreferredPersonId` in `server.ts`) — this is exactly the piece that used to
  let anyone spoof "who's asking about whom," and it's fixed everywhere that actually
  gates disclosure. What's left is narrower and lower-stakes: GitHub/Jira/Gmail connect,
  ingest tokens, sub-agent registration, and claim correction still use the more
  permissive `requireSelfIfLoggedIn` — open when there's no session at all (most of the
  seeded 40-person roster has no linked account and never will in a demo context), open
  when a real session exists but has no linked identity in *this* id's org, and only
  fails closed on a genuine mismatch (a real, linked session trying to touch a different
  real person's own connections). Tightening these to the same unconditional
  session-preferring treatment `/api/agent/ask` gets is the honest remaining gap — real,
  but these are personal tool connections, not org-wide disclosure, so the blast radius of
  leaving them as-is is much smaller than what was just closed. "My agent"'s free identity
  switcher (`MeContext.tsx`) stays deliberately open regardless of login either way — a
  documented demo affordance, not an oversight, and several real self-service transparency
  endpoints (`/api/org`, `/api/policy` GET, `/api/audit/subject/:id`) depend on reaching it
  without a session; do not blanket-gate those without re-checking every frontend caller
  first (found the hard way during the same audit — three of six initially-flagged
  endpoints turned out to be this, not oversights).

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

Model-agnostic main agents are built and live-verified against a real local Ollama model —
one `ModelProvider` adapter each for Claude and for anything OpenAI-compatible (ChatGPT,
or a self-hosted/open-source model — same adapter, `OPENAI_BASE_URL` is the only knob),
never hardcoded to one vendor — see `docs/agent-to-agent-communication.md` §15/§15a. The
main agent is an org-level setting, not a per-person one: one registration
(`org_main_agent`) shared by everyone in the org, set only by an admin
(`POST /api/organizations/:orgId/main-agent`, `requireOrgRole` 'admin'). Every person's
own "Set up my agent" shows it read-only — there is no per-person main-agent registration
anymore. `person_runtimes` still exists but only ever holds personal sub-agents now
(Claude Code, GitHub, etc. as status-check tools the org's main agent can query); it lost
its old main/sub distinction entirely along with it.

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
specific on-prem box) since `runtime_catalog` is global, shared by every org. Real and
typechecked/tested (round-trip encryption, credential-resolution fallback), but only
self-tested against one Anthropic key locally — not yet verified with two different real
organizations actually using two different real providers side by side in a live
deployment. Its `base_url` is the one place this app ever fetches a URL an org admin
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
targetId`, matching the free-identity-switcher leniency below) or a real org viewer+ role
— since `PolicyMatrix.tsx`'s admin policy-testing panel and `Preview.tsx`'s self-service
"what would X role see about me" both depend on bypassing role-*truthfulness* on purpose,
just not on being a real caller. Three read endpoints
(`/api/overview`, `/api/escalations` GET, `/api/connections`) were completely
unauthenticated, gated only by a guessable `orgId` query param — now `requireOrgRole`
'viewer'-gated like `/api/audit` always was. Three siblings that look identical at a
glance (`/api/org`, `/api/policy` GET, `/api/audit/subject/:id`) are **deliberately left
open** — real self-service endpoints (`MeContext.tsx`'s free switcher, `WhoAsked.tsx`,
`Ask.tsx`, `MyAgent.tsx`, `OrgStructure.tsx`) depend on reaching them without a session,
per rule 7 below; gating them would break real functionality, not close a gap. Also
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

Real per-person accounts, multi-org membership, and self-serve org creation are built —
one `accounts` table is the login for everyone, admin or employee or both; the same
account can administer several orgs and be a person in several orgs at once (two
independent facts, `org_admins` and `people.account_id`, never conflated); anyone can
create a brand-new organization from scratch with no existing admin (`POST /auth/signup`,
`repo.ts`'s `signUpWithNewOrganization`, one atomic transaction). Adding someone with an
email (an org-admin invite, or a person added to a chart) also emails them their one-time
temp password when `RESEND_API_KEY` is configured (`integrations/resendEmail.ts`) — not
yet live-verified, see "Where to go next" — and always still shows it once in the
inviting admin's own UI regardless, so nothing about the invite depends on email working.
A fresh login also now lands wherever makes sense: someone with an admin role goes to
Admin, someone who's only ever a person in a chart goes straight to "My agent" instead of
an empty Admin panel (`App.tsx`'s `Shell`, keyed off a genuine login transition, not just
having a session on page load). What none of this does yet is change what any individual
*request* is trusted to say about its own identity — see "Where to go next" and rule 7.

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
