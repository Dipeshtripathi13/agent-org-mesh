# Agent-to-agent communication: design for arbitrary-question orchestration

**Scenario this solves:** the CEO asks the Finance Manager's main agent an *arbitrary*
free-text question — "what's the finance update this week?" The Finance Manager's main
agent has to gather what happened this week from its own resources (which may be several
personal sub-agents it runs), synthesize an answer, and return it — without the CEO
having any visibility into, or direct access to, those sub-agents.

This is not a new feature bolted onto the mesh. It's the mesh's stated purpose
(`CLAUDE.md`: *"Agents answer questions across and up the org chart"*), extended from
"disclose a standing list of known claims" to "synthesize a direct answer to whatever was
actually asked." The gap between those two is smaller than it looks, and closing it does
not require touching the one file this whole app is built to protect
(`backend/src/domain/policy.ts`).

## 1. The constraint everything else is designed around

CLAUDE.md rule 1: *"The policy engine is deterministic code, never a prompt. No LLM, no
randomness, no clock reads."* That rule doesn't forbid an LLM from being involved in
answering questions — it forbids an LLM from being involved in **deciding who is allowed
to know what**. Those are separable, and keeping them separate is the entire design.

Concretely: `respond()` in `policy.ts` already computes, deterministically, exactly which
claims a given requester role is allowed to see, redact, or have refused. That computed
set — not the raw claims, not the target's underlying data — is the *only* thing that may
ever reach an LLM. The LLM's job is narrower than it sounds: turn an already-authorized
set of facts into a readable answer to a specific question. It never sees anything it
wasn't already going to be allowed to disclose.

## 2. Why not literal agent-to-agent messaging

The framing "the CEO's agent talks to the Finance Manager's agent" suggests two live,
independent processes exchanging messages directly. Don't build that. Two things:

**It doesn't match what's actually running.** There is no "CEO's agent" process today —
asking about someone is a single API call carrying a role and a requester id. Building
literal inter-agent messaging would mean standing up a second live agent per person,
which is a much bigger system for no corresponding benefit here.

**More importantly, it would weaken the actual guarantee.** If the Finance Manager's
agent decides for itself what to disclose, you're trusting that agent (an LLM, running
under whatever provider it's registered with) to correctly and consistently enforce
policy, every time, with no drift, no prompt-injection risk, and no way for a third party
to audit that it did. That's precisely the failure mode CLAUDE.md's rule 1 and rule 2
exist to prevent. A **single deterministic arbiter both sides go through** is not a
limitation of this design — it's the reason the audit log and policy engine can make any
guarantee at all.

(For what it's worth, this lines up with real prior art: Google's [A2A protocol](https://a2a-protocol.org/latest/specification/)
— which *does* define how independent agents exchange tasks and artifacts —
deliberately says nothing about what a receiving agent is authorized to disclose.
Authorization inside the agent's own boundary is explicitly left to the implementer.
That's this document.)

## 3. Vocabulary this design is built on

Borrowing established terms rather than inventing new ones:

- **PDP — Policy Decision Point.** The thing that evaluates policy and decides
  allow/redact/refuse. In this codebase, that's `respond()`. Unchanged by this design.
- **PEP — Policy Enforcement Point.** The thing that enforces the PDP's decision at the
  point of use. In this codebase, that's the surface-connectivity check inside
  `respond()` (a claim whose `sourceSurface` isn't `connected`/`partial`/`stale` for the
  target is never asserted, full stop — see `usableSurfaces()` in `coverage.ts`).
- **Pre-filtering, permission-aware RAG.** The overall pattern: resolve the authorized
  content set *before* retrieval/generation touches it, rather than generating first and
  filtering after. This is the opposite of naive RAG, and it's what makes this safe to
  put an LLM in the loop at all.
- **Orchestrator–worker.** Anthropic's own term (from
  [their multi-agent research writeup](https://www.anthropic.com/engineering/multi-agent-research-system))
  for: a lead process plans and delegates, workers gather in parallel each in their own
  context, and a synthesis step compresses their findings. That's the shape of "main
  agent aggregates from multiple sub-agents," and it's the shape this design uses for
  resource gathering.
- **MCP's control hierarchy**, for the sub-agent side specifically: MCP distinguishes
  *tools* (model-controlled — the LLM decides to invoke them) from *resources*
  (application-controlled — the host decides what's attached, the model doesn't get a
  vote). Sub-agent activity in this design is a **resource**, gathered by application
  code before the LLM call, never a tool the model reaches for mid-conversation. That
  distinction is what keeps the PDP in front of the LLM instead of beside it.

## 4. Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              /api/agent/ask                 │
                    │  { targetId, requesterId, requesterRole,     │
                    │    question }                                │
                    └───────────────────┬───────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  1. GATHER (orchestrator-worker, parallel) │
                    │     for each connected resource provider   │
                    │     the target has:  claude-code, gmail,    │
                    │     github, jira, ...  → ActivitySection[]  │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  2. INGEST → upsert real Claim rows        │
                    │     (existing realClaims.ts pattern,       │
                    │     generalized — one claim per source)    │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  3. PDP — respond() — UNCHANGED            │
                    │     deterministic, no LLM, no randomness   │
                    │     → AgentResponse.items[]                │
                    │       (already tier/redact/refuse-resolved)│
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  4. FILTER — keep only disposition=allow   │
                    │     items. Drop WONT and CANT text          │
                    │     entirely from what the LLM sees —       │
                    │     count only.                             │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  5. SYNTHESIZE — one Claude API call        │
                    │     (question + allowed items only)         │
                    │     → natural-language answer                │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  6. AUDIT — append immutable snapshot        │
                    │     (existing audit.ts, unchanged)            │
                    └───────────────────────────────────────────┘
```

## 5. The one security rule that matters most

This is the part worth getting exactly right, and it's more specific than "filter before
you generate." Looking at what `respond()` actually returns today (`policy.ts:146-170`):

| Disposition | Tier returned | What `item.text` actually contains |
|---|---|---|
| `allow` | the claim's real tier (T1/T2/T3) | the full real claim text |
| `redact` | `WONT` | **the claim's first sentence**, verbatim, plus a withheld-detail notice |
| `refuse` | `WONT` | a fully generic message, zero real content |
| (structural) | `CANT` | a fully generic message, zero real content |

The `redact` case is the trap. It's *designed* to leak a real, verbatim sentence to a
human reader — that's the product's own "refuse visibly" philosophy, and it's correct for
a human reading a list. It is **not** safe to feed into a synthesis prompt. An LLM asked
to "answer the question using this context" will treat that one real sentence as a
foothold and may reasonably elaborate, connect it to the question, or imply more than the
single sentence supports — reconstructing exactly the "remaining detail" the policy
engine just withheld.

**Rule: only `AgentResponse.items` where `policyRef === null` and `tier !== 'CANT'` may
have their `text` passed into the synthesis prompt.** Everything else — `WONT` items from
either `redact` or `refuse` — contributes to the prompt only as a count
("N item(s) were withheld and are not included below"), never as text. The requester
still sees the full item list as they do today (nothing about visibility changes); it's
specifically the *synthesis input* that's narrower than the *disclosure output*.

```ts
// backend/src/integrations/orchestrator.ts
function allowedTextOnly(items: ResponseItem[]): { allowed: ResponseItem[]; withheldCount: number } {
  const allowed = items.filter((i) => i.policyRef === null && i.tier !== 'CANT');
  return { allowed, withheldCount: items.length - allowed.length };
}
```

## 6. Generalizing resource gathering (the "multiple sub-agents" part)

Today's `ingestClaudeCodeClaim()` (`backend/src/integrations/realClaims.ts`) is hardcoded
to one source. Generalize it into a registry any connected surface can plug into:

```ts
// backend/src/integrations/resourceProviders.ts
export interface ResourceProvider {
  surfaceKey: SurfaceKey;           // must exist in surfaces_catalog
  /** since lets a caller ask for "this week" instead of always "today". */
  gather(personId: number, since: Date): Promise<{ digest: string; recordedAt: string } | null>;
}

export const PROVIDERS: ResourceProvider[] = [
  claudeCodeProvider,   // wraps getTodaysClaudeCodeActivity, generalized to a since-window
  gmailProvider,        // wraps getTodaysEmails — personal-only today; see §8
  // githubProvider, jiraProvider, ... — same shape, once those become real
];

export async function gatherAll(orgId: number, personId: number, since: Date) {
  const person = await repo.getPerson(personId);
  const connected = PROVIDERS.filter((p) => person.surfaces[p.surfaceKey] === 'connected');

  // Parallel fan-out, Anthropic's orchestrator-worker shape. allSettled — one provider
  // timing out (a slow Gmail call, a locked file) must never take down the others.
  const results = await Promise.allSettled(connected.map((p) => p.gather(personId, since)));

  const sections: ActivitySection[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      sections.push({ source: connected[i].surfaceKey, digest: r.value.digest });
    }
    // rejected → logged, silently omitted, exactly like today's try/catch around
    // ingestClaudeCodeClaim in server.ts. A missing source is not an error to the caller.
  });
  return sections;
}
```

Each section still gets upserted as a real `Claim` (reusing `repo.upsertClaim` /
`upsertEvidence`, one row per source, same idempotent id-per-person-per-day pattern
already built) — so the *existing* standing-disclosure flow (Ask, Preview, PolicyMatrix)
keeps working exactly as it does today, unchanged. Synthesis is additive, not a
replacement.

### 6a. Question-aware selection — implemented 2026-08-18

The version above (and the shipped `gatherAll()` for its first several months) fans out
to *every* connected provider on *every* ask, regardless of what's being asked — "did
Diego touch the calendar today" still fired a live GitHub call and a live Jira call for
no reason. As of this pass, `gatherAll()` takes an optional `question`, and when one is
present, a router call decides which connected surfaces are plausibly relevant *before*
any of them get invoked:

```ts
// backend/src/integrations/anthropic.ts
export async function selectRelevantSurfaces(
  question: string,
  candidates: SurfaceDescriptor[],  // { surfaceKey, reads } — same `reads` copy shown to the employee
): Promise<Set<string>> {
  if (!anthropicConfigured()) return new Set(candidates.map((c) => c.surfaceKey)); // fail open
  const raw = await callClaude([...]);  // "return ONLY a JSON array of relevant surfaceKeys"
  return parseRelevantSurfaces(raw, candidates.map((c) => c.surfaceKey));           // orchestrator.ts, pure, tested
}
```

`gatherAll()` then only invokes the returned subset:

```ts
// backend/src/integrations/resourceProviders.ts
let toRun = connected;
if (question?.trim()) {
  const relevant = await selectRelevantSurfaces(question, candidates);
  toRun = connected.filter((p) => relevant.has(p.surfaceKey));
}
```

Same security posture as §5, applied one stage earlier: the router only ever decides
*which real-world calls get made*, never *what gets disclosed* — `respond()` still gates
every claim gathered, exactly as before, whether a surface ran this time or not. And it
fails open at every stage that matters, because a tool-selection stage's failure mode has
to be "gather everything" (the pre-router behavior), never "silently gather nothing":

- No `ANTHROPIC_API_KEY` configured → every connected surface runs, unconditionally.
- The Claude API call itself errors → caught, every connected surface runs.
- The response isn't valid JSON, isn't an array, or every returned key is unrecognized →
  `parseRelevantSurfaces` (`orchestrator.ts`, pure, 10 unit tests) returns the full
  candidate set rather than an empty one.
- The router prompt is explicitly instructed to include a surface whenever it's unsure,
  and only exclude one it's confident is irrelevant.

No `question` at all (the standing-disclosure paths — `/api/query` for Preview and the
Policy Matrix test panel, which don't carry a specific free-text question) skips the
router entirely and gathers everything, same as always — narrowing what gets fetched is
only safe when there's an actual question to judge relevance against.

### 6b. Per-surface time window, router-inferred — implemented 2026-08-31

Every ask before this pass — org self-ask, cross-person Ask, and the personal (no-org)
"Ask yourself" — carried one manually-picked, global "Today / This week" toggle that
applied uniformly to every connected surface, regardless of which tools the router
actually decided were relevant. Found live, reported directly: that doesn't scale to
"hundreds of connected tools," and a two-option toggle can't express anything more
specific than those two windows even for the tools it does apply to. `selectRelevantSurfaces`
now returns `Map<surfaceKey, sinceDays>` instead of `Set<surfaceKey>` — the router decides,
per surface, both *whether* it's relevant and *how many days back* to look, inferred from
the question's own wording ("today" → 1, "this week" → 7, "this month" → 30, no time frame
stated at all — "what's my latest X" — → `DEFAULT_SINCE_DAYS`, 90):

```ts
// backend/src/integrations/orchestrator.ts
export const DEFAULT_SINCE_DAYS = 90;
export function parseRelevantSurfaces(raw: string, candidateKeys: string[]): Map<string, number> {
  // parses [{surfaceKey, sinceDays}, ...] — also tolerates a bare surfaceKey string
  // (a weaker/local model ignoring the richer shape), defaulting that entry to
  // DEFAULT_SINCE_DAYS rather than treating the whole response as unparseable.
}
```

`gatherAll()` and `POST /api/agent/ask-personal`'s digest bridge both compute each
provider's own `since` date from its own map entry (`sinceDaysByKey.get(surfaceKey) ??` the
caller's fallback), instead of one `since` shared by every provider in the run. Fails open
the same way §6a already did, just with a generous window attached: unconfigured provider,
API error, or a fully-unrecognized response → every connected surface runs, at
`DEFAULT_SINCE_DAYS`. The "Today / This week" UI toggle (`MyAgent.tsx`, `Ask.tsx`) and the
`window` request-body field it drove (`POST /api/agent/ask`, `POST /api/agent/ask-personal`)
were removed outright, not left disabled or optional alongside the router — the whole point
was one fewer manual thing to scale per tool, not two ways to arrive at the same window.

## 7. The new endpoint

```
POST /api/agent/ask
{
  targetId: number;
  requesterId: number;
  requesterRole: RequesterRole;
  question: string;
  persist?: boolean;      // same meaning as /api/query today
}
→
{
  answer: string;               // synthesized, from allowed items only
  items: ResponseItem[];        // unchanged — the full, existing structured disclosure
  withheldCount: number;        // WONT + CANT count folded into the prompt as a fact,
                                 // never as their text
  coverage: CoverageStatement;  // unchanged
}
```

Handler, in terms of what's already built:

```ts
app.post('/api/agent/ask', async (req, reply) => {
  const { targetId, requesterId, requesterRole, question, persist } = req.body as {...};
  const orgId = await repo.getOrgIdOfPerson(targetId);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // "this week" — see §8

  await gatherAndIngest(orgId, targetId, since);      // §6, replaces the single
                                                        // ingestClaudeCodeClaim call
  const [target, claims, surfaces, revision] = await Promise.all([ ... ]); // unchanged
  const snapshot = respond({ target, claims, surfaces, requesterRole, revision, now }); // UNCHANGED — the PDP

  const { allowed, withheldCount } = allowedTextOnly(snapshot.items);     // §5
  const answer = allowed.length
    ? await answerFromActivity(target.name, question,
        allowed.map((i) => ({ source: i.tier, digest: i.text })))         // reuses the
                                                                            // function built
                                                                            // for personal Ask
    : `Nothing about ${target.name} is disclosable to you right now.`;

  if (persist) await repo.appendAuditEntry({ ...snapshot, question, /* + answer, see §9 */ });
  return { answer, items: snapshot.items, withheldCount, coverage: snapshot.coverage };
});
```

Notice this reuses four things verbatim: `respond()`, `repo.appendAuditEntry()`,
`answerFromActivity()` (already built for the personal "Ask Claude" box), and the
raw-digest fallback pattern (`rawActivityDigest`) for when no `ANTHROPIC_API_KEY` is
configured — same no-LLM-key story as the personal feature: falls back to handing back
the allowed items' text directly, clearly labeled, rather than erroring.

## 8. Two things this exposes that need an explicit decision

**"This week" vs. "today."** Everything built so far (`getTodaysClaudeCodeActivity`) is
hardcoded to today. The Finance Manager scenario needs a real window. Recommendation:
thread a `since: Date` through the resource-provider interface (shown above) rather than
hardcoding "today" a second time. Each provider decides how to honor it — for Claude Code
that means scanning session files by mtime across the window, not just today's.

**Gmail stays personal-only, on purpose — this design doesn't change that.** §6's
registry *could* include a `gmailProvider`, but the earlier decision to keep Gmail out of
the org-visible claim pipeline (personal "Ask" box only, never a manager-visible claim)
should hold here too, for the same reason: email is a materially different privacy bar
than "which files did you edit." If a real finance tool (a ledger, an expense system)
becomes a provider instead, that's a much easier call than inbox content — treat it like
GitHub/Jira, not like Gmail.

## 9. Audit trail

`AuditEntry.snapshot` is `AgentResponse`, stored once, immutably, per rule 2. Add one
optional field to `AgentResponse` — `synthesizedAnswer?: string` — populated only when
`/api/agent/ask` was the caller. Nothing about the append-only guarantee changes: the
answer is resolved once, at the moment it's given, and stored whole in the same snapshot
as the items it was built from. A later policy change still can't retroactively alter
what the CEO was told last Tuesday — it just also can't alter the sentence Claude wrote
about it, for the same reason.

## 10. Implementation phases

1. **Generalize the provider registry** (§6) — mechanical refactor of
   `ingestClaudeCodeClaim` into the `ResourceProvider` shape. No behavior change; existing
   flows keep working. Add the `since` parameter now even though only "today" is used yet.
2. **Add `allowedTextOnly()` and `/api/agent/ask`** (§5, §7) — new endpoint, additive,
   nothing existing changes shape.
3. **Frontend**: a new panel (or extend `Ask.tsx`) that shows the synthesized `answer` as
   the headline, with the existing structured `items` list underneath as "how this was
   derived" — same relationship personal "Ask Claude" already has between its narrative
   answer and the raw digest fallback.
4. **`since` window as a UI parameter** — let the requester pick "today" / "this week" /
   custom range, once more than one provider needs it.
5. **(Later, optional)** — if cross-org-boundary requests ever matter (a partner org's
   agent asking about someone here), *that's* when an A2A-shaped Task/Artifact envelope
   earns its complexity: `submitted → working → completed`, an `Agent Card` advertising
   what this mesh's endpoint accepts, `auth-required` as an explicit intermediate state.
   Not needed for one org asking about its own people — the synchronous shape in §7 is
   sufficient until there's a real second party on the other end of the wire.

## 11. What this deliberately does not do

- It does not give the LLM a "tool" to go fetch more data mid-answer. Resource gathering
  is a fixed, pre-computed step (§6) that finishes before the PDP even runs. An LLM that
  can decide to pull more context *after* seeing the question is an LLM with a say in
  what gets disclosed — exactly what §1 rules out.
- It does not let a sub-agent answer on the target's behalf. Sub-agents are read as
  resources (MCP's application-controlled resource, not model-controlled tool) — data
  in, never a voice of their own in the conversation.
- It does not change what any requester is *shown*. `items` is returned exactly as
  `respond()` computed it, same as `/api/query` today. `answer` is a new, additional
  convenience — a readable synthesis of the same authorized set, not a separate channel
  with different rules.

## 12. What OpenClaw's architecture confirmed and what it fixed

[OpenClaw](https://docs.openclaw.ai/) is a real, actively-developed open-source
autonomous-agent platform with a genuine sub-agent spawning and inter-agent messaging
system — the closest real-world architecture to what §2 argued against building. It's
worth engaging with directly rather than dismissing on priors, so this project's research
went and read its actual spec, plus the (numerous) published security analyses of it.

**The verdict confirmed §2's argument rather than complicating it.** OpenClaw's own
[security docs](https://docs.openclaw.ai/gateway/security) state its isolation is *"a
defense-in-depth model rather than hostile multi-user isolation,"* built for one trusted
operator per gateway. Its sub-agent tool (`sessions_spawn`) takes a free-text `task`
string with no typed, pre-checked authorization — the disclosure decision, such as it is,
lives inside the receiving model's judgment. The published security literature on it
converges on exactly the failure mode §1 of this document exists to prevent: [*A Security
Analysis of the OpenClaw AI Agent Framework*](https://arxiv.org/html/2603.27517v3)
documents advisory GHSA-w5c7, *Inter-Session Context Contamination* — *"the model cannot
distinguish between 'an end user issued this instruction' and 'another agent in the same
deployment issued this instruction routed through the session infrastructure.'"* [*Caging
the Agents*](https://arxiv.org/abs/2603.17419) cites a red-team exercise where 124 email
records were disclosed to a non-owner via a framed request — the multi-agent equivalent
of a WONT-class claim reaching an unauthorized reader because nothing checked before the
model saw it. This project's `allowedTextOnly()` (§5) already structurally prevents that
class of leak: withheld items aren't labeled-but-included, they're absent from the prompt
entirely.

**One real, concrete gap did surface, and it's now fixed, not just discussed.** OpenClaw's
literature repeatedly names the root cause as identity that's asserted rather than
verified — allowlists keyed on mutable display names, senders trusted by message content
instead of structure. Checking this codebase against that finding found the same shape of
bug: `/api/query` and `/api/agent/ask` accepted whatever `requesterRole` the client sent,
with nothing checking it against the org graph. A caller could claim `"Executive"` about
anyone and the deterministic grid downstream would honor it — deterministic, but fed a
forged input. Fixed in `policy.ts`'s `deriveAllowedRoles()`: the *true* set of roles a
requester may claim for a given target, computed from the org graph itself (manager
chains, team membership), never from anything the requester asserts. Both endpoints now
call it and reject (403) any persisted ask whose claimed role isn't in that set —
Preview and the policy test panel stay exempt, since nothing they do is a real,
audited disclosure event. Golden-tested the same way as everything else in `policy.ts`.

**What was deliberately borrowed anyway**, because it's good architecture independent of
OpenClaw's authorization gap:
- **Depth-indexed capability attenuation, applied structurally rather than by depth
  count.** OpenClaw's sub-agents structurally cannot address outside channels
  (`sessions_spawn` rejects delivery params for children). This codebase's resource
  providers (`resourceProviders.ts`) have the same property by construction — a
  `ResourceProvider` is a `gather`-and-`ingest` function with no reply path at all, not a
  capability that happens to be unused.
- **Runtime-derived status over model-derived status.** OpenClaw's announce envelope
  reports `ok|error|timeout|unknown` from the runtime, never from model text. This
  project's `withheldCount` and `coverage` were already computed in code before this
  research (§5, §7) — confirmed as the right call rather than changed.
- **Provenance via evidence, not narrative.** OpenClaw's forensics paper found delegation
  chains that couldn't be attributed without manual reconstruction. Every claim this
  system discloses already carries an `evidenceId` back to a real, upsertable `Evidence`
  row (`realClaims.ts`) — confirmed sufficient, not extended.

**What was explicitly rejected**, named directly against OpenClaw's pattern:
- A free-text task/question field influencing *what's disclosed* — this system's
  `question` only shapes how an already-authorized set is *written up*; `respond()` never
  sees it, so no phrasing of a question can expand access.
- "Labeling" untrusted or restricted content as a substitute for withholding it.
  OpenClaw's `EXTERNAL_UNTRUSTED_CONTENT` wrapper still hands the data to the model, just
  marked. This system's rule 5 (withholding is always visible) is stronger and
  incompatible with that pattern by design: withheld means absent, not flagged.

## §13 — self-service connectors: how a real person connects their own tool

Every real connection built so far (Claude Code's local session log, Gmail OAuth) was
wired up *by the implementer*, for specific people, on this specific machine. That's fine
for a demo org but doesn't generalize: a real user's Claude Code, Codex CLI, or Gemini CLI
runs on *their* laptop, not wherever this backend happens to be deployed. The backend
can't read a filesystem it doesn't have access to. This section covers the general,
non-hardcoded mechanism — anyone can connect their own tool, no code change required.

**What each tool actually supports (researched, not assumed):**
- **Claude Code** — native `command`-type hooks (`.claude/settings.local.json`, or the
  global `~/.claude/settings.json`). A hook receives the event's JSON on stdin and runs an
  arbitrary shell command — `curl`ing that JSON straight to an external URL is a standard,
  well-documented use. `PostToolUse` was chosen specifically because its payload carries
  `tool_name`/`tool_input` inline; no session-transcript file access is needed on the
  receiving end.
- **Codex CLI** and **Gemini CLI** — both expose comparable hook/telemetry config
  (`~/.codex/config.toml`'s `[hooks]`/`[otel]`, `.gemini/settings.json`'s telemetry
  block), but the exact keys vary by version and weren't independently verified against a
  running install the way Claude Code's was. Rather than ship an unverified snippet as
  fact, the UI gives these tools the same underlying primitive — a `curl` one-liner POSTing
  either the tool's native hook payload or a small generic JSON shape — and points at each
  tool's own docs for wiring it into their specific hook mechanism.
- **Consumer ChatGPT and Gemini (the web apps)** have no self-service API for a third
  party to read a user's personal chat history — confirmed, not assumed: Google's Data
  Portability API has no Gemini scope, Gemini Apps history is Takeout-export-only, and
  OpenAI's Compliance API is an Enterprise/Edu admin capability, not something an
  individual user can grant. This is a real, structural gap, not a `WONT` — there is
  nothing to connect *to* here, which is the same CANT-vs-WONT distinction CLAUDE.md
  already draws for Workday/Ironclad/benefits/DMs, just discovered on the tool side rather
  than the org side.

**The pattern chosen: self-generated Personal Access Token, not a shared secret or
identity claimed by the client.** Same shape as PostHog/Zapier/Datadog's self-service
ingest: a person generates a token in `Set up my agent → Connect real tools`, pastes it
into their own tool's config, and their tool pushes activity to
`POST /api/ingest/:source` itself. The token is the *entire* authentication boundary:

- `ingest_tokens` stores only a SHA-256 hash (`insertIngestToken`, `db/schema.sql`) — the
  raw value is shown exactly once, at generation time, and can never be recovered from a
  DB dump. Revocation sets `revoked_at`, never a `DELETE`, so a used-then-revoked token
  stays visible in its own history (same non-destructive pattern as demoting a main agent
  to sub, §9).
- `resolveIngestToken` is the *only* place a hash is ever compared, and it's what
  `POST /api/ingest/:source` calls to establish who a pushed event belongs to
  (`ingestTokens.ts`). The request body's contents — tool name, `tool_input`, anything —
  are never trusted for identity, only for what happened. This is the direct extension of
  the same lesson `deriveAllowedRoles` already enforces for a claimed org-chart
  relationship (§12): identity comes from something structurally hard to forge, never from
  an assertion sitting next to it in the same payload.
- Recognized/interesting tool calls (`Bash`, `Edit`, `Write`, `NotebookEdit` — the same
  `NARRATIVE_TOOLS` set `claudeCodeActivity.ts` already used for the local-file read) are
  persisted to `ingested_events`, insert-only, one row per observation. Everything else —
  most hook firings, since a hook fires on *every* tool call — is accepted with `202` and
  silently dropped, not stored and not an error.
- `claudeCodeActivity.ts`'s `getClaudeCodeActivitySince` now takes an optional `personId`
  and, when given one, merges `ingested_events` (source `claude-code`) in with whatever it
  finds on the local filesystem. Either source alone is enough to mark activity
  `available`; both flow into the same claim through the unmodified `ingestClaudeCodeClaim`
  → `respond()` pipeline, exactly like every other real claim in this system. One real bug
  surfaced and got fixed during implementation: the original merge appended pushed events
  *after* the local scan and then capped the array at `MAX_ACTIONS` from the front, which
  silently dropped pushed data whenever the local log alone already filled the cap — fixed
  by keeping the *last* `MAX_ACTIONS`/`MAX_FILES` entries instead of the first, so pushed
  events (and their recency) always survive the cap.

**What this deliberately doesn't do:** no bespoke parser for every version of every tool's
native hook/OTel schema — Codex CLI and Gemini CLI get the same generic `curl` primitive
Claude Code does rather than three separately-maintained integrations for shapes that
weren't verified against a live install. No global `~/.claude/settings.json` write from
this codebase — the copy-paste snippet targets the project-local, gitignored
`.claude/settings.local.json`, so nothing here silently changes a user's default
configuration outside the project they're choosing to report on.

**Update — codex/gemini-cli got the full treatment, not just the personal Ask box.**
Originally `codex`/`gemini-cli` pushed events were accepted and stored but never read back
anywhere — a real gap, found during a consistency pass, worse than not accepting them at
all (looked like it worked, silently did nothing). Fixed properly rather than papered
over: `SurfaceKey` now includes both (`domain/types.ts`), `surfaces_catalog` has real
entries for them, and `realClaims.ts`'s `ingestPushedEventsClaim` (one generic function,
not two copies) turns their pushed events into real `T2`/`Internal` claims through the
unmodified PDP — the exact same treatment `github` got, registered as `ResourceProvider`s
in `resourceProviders.ts`. Since a bare token doesn't prove anything is actually being
pushed (unlike GitHub, where a PAT can be verified against the API immediately), the
surface flips to `connected` on the **first real event landing**, not at token-generation
time — verified live: pushing one event auto-connected the surface, and the resulting
claim appeared in both `/api/query`'s disclosure list and the personal Ask box's sources,
with zero special-casing needed in the latter once the generic claims-based section
builder existed.

## §14 — local same-machine IPC: what OpenClaw's pattern is, and what actually shipped

Prompted by: does OpenClaw's local main-agent ↔ sub-agent connection mechanism generalize
to something this project could adopt?

**Finding: no, and the reason why is itself useful.** OpenClaw's `sessions_spawn` isn't
real IPC — the Gateway is a single persistent Node.js process holding every session in
memory/SQLite; a sub-agent's result is delivered by splicing it back into the parent's own
transcript as a new turn (`sessions_yield`), never over a socket, file, or callback. That
only works because parent and child share one process. It doesn't map onto this project at
all — our "sub-agents" are different people's independent tools on independent machines.
If anything, this confirmed the existing design (real activity → a Claim → the unmodified
deterministic PDP) was the right call, not a compromise.

**What did generalize, from a different branch of the same research**: whether any tool
exposes a real, *live*, synchronous local attach point.
- Codex CLI shipped `codex app-server --listen ws://…` (JSON-RPC 2.0 over WebSocket) —
  real, but flagged experimental and requires the user to keep a separate process running.
- Claude Code has no such server (the equivalent GitHub issue was closed `not_planned`).
- The **Claude Agent SDK** looked like the fix, but is a hard no: Anthropic's own docs
  state third-party products "are not allow[ed] to offer claude.ai login... for their
  products, including agents built on the Claude Agent SDK" — it requires its own paid
  `ANTHROPIC_API_KEY`, the exact separate-billing cost this project's owner already
  declined once (see the `rawActivityDigest` fallback, built for the same reason).
- **What actually shipped instead**: the `claude` CLI's own headless mode (`claude -p`)
  reads the same subscription OAuth credentials as interactive use — confirmed against the
  installed CLI, not just the docs (`claudeCli.ts`'s `askClaudeCli` shells out to it with
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` stripped from the subprocess env, since a
  present key silently overrides subscription login in non-interactive mode). This is a
  genuinely different signal from everything else in `claudeCodeActivity.ts`: that reads
  what a session *already did* (a transcript); this spawns a fresh, read-only
  (`--allowedTools Read,Grep,Glob`, `--permission-mode dontAsk`) investigation of the
  project directory *right now*. Real either way — just not the same kind of real, and the
  UI labels it `LIVE` rather than reusing the existing `REAL` badge for that reason. One
  honest cost caveat surfaced during live testing: even a trivial call consumes real
  subscription usage (confirmed via the CLI's own `total_cost_usd` field on a test call) —
  surfaced directly in the UI copy, not hidden.

New endpoint: `POST /api/person/:id/runtimes/claude-code/ask-live` — claude-code only,
there's no equivalent CLI to shell out to for the other catalog runtimes yet.

## §15 — model-agnostic main agents

Prompted by: picking "ChatGPT" as your main agent (`Set up my agent`) persisted a string
in `person_runtimes` and changed nothing else. `runtime_catalog` has always listed Claude,
ChatGPT, Copilot, Gemini, self-hosted Llama, Mistral (`seed.ts`) — the product's own
concept already anticipated multi-vendor and local main agents — but every real ask-time
LLM call (`integrations/anthropic.ts`) went to Anthropic regardless of what a person had
actually registered. Confirmed by reading the two call sites that mattered:
`POST /api/person/:id/main-agent` (`server.ts`) only validated the key was in a hardcoded
allowlist; the answer-generation endpoints never read the registration back out at all.

**The fix is one interface, two adapters — matching wire *protocols*, not vendors.**

```ts
// integrations/modelProvider.ts
export interface ModelProvider {
  configured(): boolean;
  selectRelevantSurfaces(question: string, candidates: SurfaceDescriptor[]): Promise<Set<string>>;
  synthesize(personName: string, question: string, sections: ActivitySection[]): Promise<string>;
  writeClaim(personName: string, digest: string): Promise<string>;
}
```

- `anthropicProvider` — thin wrapper around the existing, unmodified `anthropic.ts`.
- `openaiCompatibleProvider` (`integrations/openaiCompatible.ts`) — fetch-based, no new
  SDK dependency, against `POST {OPENAI_BASE_URL}/chat/completions`. This single adapter
  serves ChatGPT *and* any open-source or self-hosted model — Ollama, vLLM, LM Studio,
  text-generation-webui, and everything else in that ecosystem all speak this exact wire
  format. Pointing `OPENAI_BASE_URL` at `http://localhost:11434/v1` to use a local model
  instead of OpenAI's own API is the *entire* configuration change — no new code, no new
  adapter, no per-model branch anywhere in the app. This is what makes the surface
  actually flexible rather than flexible-in-name: the abstraction boundary is the protocol
  a server speaks, not a hand-maintained list of vendors.

`runtime_catalog` gained an `api_family` column (`'anthropic' | 'openai-compatible' |
'unsupported'`) as the single source of truth for which runtimes are real.
`integrations/runtimeProvider.ts::getMainProvider(personId)` reads that person's real
`person_runtimes` main registration and resolves the matching adapter — `providerForApiFamily`
is a pure mapping (unit-tested, `runtimeProvider.test.ts`), so it's exactly this one small
function that changes when a new vendor gets real support, not every call site that asks
a question. `gatherAll()`'s tool-selection router (§6a), both answer-synthesis endpoints,
and the Claude Code activity → Claim write-up (`realClaims.ts`) all now resolve a provider
this way instead of importing `anthropic.ts` directly. Every one keeps the exact same
fail-open contract §6a already established: no key, a request error, or an unparseable
response never blocks the caller.

Concretely, in the seeded catalog: `claude-sonnet` and `claude-code` are `anthropic`;
`chatgpt` **and `llama-local`** are `openai-compatible` — self-hosted Llama today is
almost always served behind an OpenAI-compatible local gateway, so this makes "a locally
deployed model" a real, selectable main agent in the UI, not a hypothetical. `copilot`,
`gemini`, and `mistral` stay `unsupported` — same honest, unchanged "simulated" behavior
they already had; no adapter was invented for a vendor with no real integration path
(same posture as this doc's own Jira UNVERIFIED note elsewhere). The main-agent dropdown
(`SetUpMyAgent.tsx`) now filters the fetched catalog on `apiFamily !== 'unsupported'`
instead of a hardcoded key list — a new supported vendor becomes selectable by adding one
seed row and one adapter file, never a frontend change.

**Deliberately not native per-vendor tool-calling.** The more typical "agentic" shape here
would be Claude's `tool_use` or OpenAI's function calling: give the model tool
definitions, let it decide which to call, feed results back, repeat. That would mean a
model reasoning directly over raw provider output — GitHub/Jira responses, before
`respond()` ever sees them — which breaks the one invariant this whole codebase exists to
protect (CLAUDE.md rule 1; §5's "redact trap" above). The existing shape keeps the model
fully out of the disclosure decision at every step: the router (an LLM call) only narrows
*which tools run*, `gatherAll` invokes them mechanically, `respond()` gates everything
deterministically, and only *then* — on text that already cleared policy — does a model
write prose. Generalizing that shape across vendors preserves it exactly; adopting native
tool-calling instead would not. This is why the interface has `selectRelevantSurfaces` and
`synthesize` as two separate, narrowly-scoped calls rather than one open-ended
"answer this, here are your tools" loop.

**Update, same day — the successful-response path is now live-verified too.** The gap
above (no local server existed to round-trip against) is closed: `openaiCompatibleProvider`
now has a real local model behind it — the exact setup below is reproducible on any Mac.

### §15a — running a real local model (Ollama) — verified 2026-08-18

**Model choice.** Ollama was already installed on the machine this ran on, with
`llama3.2:1b` (1.3 GB on disk, Meta's smallest Llama 3 release) already pulled — so that's
what got used rather than downloading something else. It's a deliberately weak choice:
1B parameters, meant for testing the *plumbing*, not answer quality. On a 16 GB Mac it
runs entirely on the integrated GPU (`ollama ps` reports `100% GPU`) with headroom to
spare alongside Postgres, the Node backend, and a browser. If you want noticeably better
answers at the same "testing only" tier, `qwen2.5:3b` or `phi3:mini` are similar-sized
alternatives; anything already in `ollama list` on your machine works without touching a
line of code — only `OPENAI_MODEL` changes.

**Setup, in order:**

```bash
# 1. Install Ollama (skip if already installed — `ollama --version` to check)
brew install ollama
brew services start ollama       # runs as a background service, like the Postgres container

# 2. Pull a small model
ollama pull llama3.2:1b          # 1.3 GB — or qwen2.5:3b / phi3:mini for a bit more capability

# 3. Sanity-check the OpenAI-compatible endpoint directly, before touching the app
curl -s http://localhost:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2:1b","messages":[{"role":"user","content":"reply with OK"}]}'
```

```bash
# 4. backend/.env — three lines, no code change
OPENAI_API_KEY=ollama-local-no-key-required   # Ollama's OpenAI-compatible endpoint
                                                # doesn't check this at all — any non-empty
                                                # string satisfies the Bearer header
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2:1b
```

```bash
# 5. Restart the backend so it re-reads .env — `tsx watch` only reloads on source-file
#    changes, not on .env edits, so this needs a real process restart, not a save-trigger.
#    (kill whatever's on :3001, then:)
cd backend && npm run dev
```

```bash
# 6. Point a real person's main agent at it — either the UI (Set up my agent → Agent
#    dropdown → "Llama 3 (self-hosted)"), or directly:
curl -s -X POST http://localhost:3001/api/person/11/main-agent \
  -H 'Content-Type: application/json' \
  -d '{"runtimeKey":"llama-local","scope":"full"}'
```

**What was actually verified, live, against this exact setup** (both Diego, person 11,
and Hana, person 10, registered as their own `llama-local` main agent — two independent
people, two independent real calls to the same local model):

- **Hana asks about Diego** (`POST /api/agent/ask`, real question, `persist:false`): the
  router genuinely called Ollama to pick relevant surfaces, `gatherAll` genuinely
  re-read Diego's real local Claude Code session log, `respond()` deterministically
  produced 4 allowed items + 1 withheld (`WONT`, the redact-trap sentence) + the CANT
  boilerplate, and — this is the part that was previously unverified — a **real
  synthesis call to `llama3.2:1b` returned genuine markdown-formatted prose** ("## Payments
  Migration Blocking\n- Vendor sandbox key: PAY-2290...") rather than the
  `rawActivityDigest` fallback text. Total round trip: ~4.8s (router + synthesis, two
  sequential calls to a cold-ish 1B model).
- **The router tolerates a small model's real behavior**: asked to "return ONLY a JSON
  array, no markdown fences," `llama3.2:1b` wrapped its answer in ` ```json ... ``` ` fences
  anyway. `parseRelevantSurfaces`'s tolerant regex (`/\[[\s\S]*\]/`, §6a) handled this
  correctly with zero special-casing — direct, live confirmation that the parser's
  fail-open/tolerant design wasn't over-engineered for a hypothetical.
- **Diego asks about Hana** (reverse direction, exercising *her* independent main-agent
  registration): `getMainProvider(10)` correctly resolved her own `llama-local`
  registration (confirmed both by `ollama ps`'s idle-unload timer visibly refreshing on
  this exact request, and by the ~0.33s response time matching one warm router call, not
  zero) — but the final answer was `"Nothing about Hana Oyelaran is disclosable to you
  right now."` This is *correct*, not a shortfall: this seed dataset only ever gave Diego
  real gatherable activity (his actual local Claude Code sessions); Hana has zero rows in
  `claims` and no real GitHub/Jira token behind her `connected` surface flags, so there was
  nothing for `respond()` to allow, and the code correctly skipped the (would-be wasted)
  synthesis call rather than inventing an answer. A data limitation of this demo org, not
  of the provider abstraction — the dispatch and router genuinely reached her own
  agent either way.

Restoring or changing which model backs a person is exactly step 6 above, run again with
a different `runtimeKey` — nothing else in the app changes.

**Bug found and fixed the same day: `provider.synthesize()` had no fallback for
"configured but unreachable."** `selectRelevantSurfaces` already fails open internally in
both adapters (try/catch around the network call, falls back to "gather everything" on
error) — that's documented above. `synthesize()` had no equivalent: a real, easy-to-hit
case (Ollama not running, a network blip, a real provider outage) threw all the way out of
`POST /api/agent/ask` unhandled, skipping the audit entry entirely instead of degrading the
way "not configured" already does. There's no *safe default* `synthesize()` could fall
back to internally — only the caller has the raw sections to hand back instead — so the
fix is a try/catch at the call site in `server.ts`, not inside the adapters. Live-verified
by pointing `OPENAI_BASE_URL` at an unreachable port for one real ask: before the fix this
would have been an unhandled rejection; after, the response was a clean `200` naming the
runtime ("Llama 3 (self-hosted) could not be reached to answer this") followed by the same
real raw-authorized-data fallback the "not configured" path already uses.
