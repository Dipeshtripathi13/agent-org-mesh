# Escalation triage — design

**Status: implemented**, per this design. `domain/escalations.ts` (+ golden tests),
`integrations/escalationEngine.ts`, the `POST /api/escalations/:id/{acknowledge,resolve}`
endpoints, and the triage UI in `Escalations.tsx` all match §§2–8 below as built —
verified live: real detection firing off `/api/query` and `/api/agent/ask`, permission
checks (path membership / IT admin / Executive) rejecting an unauthorized actor with 403,
and the org-chart badge count dropping once an escalation is acknowledged.

CLAUDE.md, "where to go next": *"Escalation triage — designed but not built. This is the
piece that stops the system being a firehose; treat it as its own project, not a bug
fix."* This is that design. Written before any code changes so the real judgment calls —
mainly, "what actually counts as escalation-worthy" — get decided deliberately, not
buried in a diff.

## 1. Current state (confirmed against the running code, not assumed)

`escalations` is entirely inert:

- `Escalation` (`domain/types.ts:216-228`) — `kind: Tier | Withheld`, `title`, `detail`,
  `personId`, `evidenceId`, `rule` (free text), `ageDays` (a stored literal), `status`
  (free text — `"Acknowledged by Jonas Weber · 3d"`), `path: string[]` (names).
- Five hardcoded rows in `seed.ts`. Nothing in `domain/` generates, updates, or derives an
  escalation from a claim, coverage report, or audit entry — zero references outside
  seed → repo → server → frontend.
- `mesh_app`'s DB grant is `SELECT` only (`schema.sql:269`) — there is no write path today,
  not even one nobody calls.
- Frontend (`Escalations.tsx`, plus a read-only listing in `OrgGraph.tsx`) renders the list
  and per-person open counts. No acknowledge/resolve action exists anywhere.
- `age_days` and `status` are both stored, hand-authored literals — that's a direct
  conflict with CLAUDE.md rule 6 ("no number that isn't derived from state") the moment
  this becomes real.

## 2. The one decision that matters most: what triggers a real escalation

The seed data's rule names (`ESC-BLOCK-10D`, `ESC-XFN-DEP`, `ESC-REVIEW-AGE`,
`ESC-DEP-REPORTED`) all imply signals this system doesn't actually have yet — ticket age,
cross-team dependencies, PR review staleness. Those need a Jira/GitHub provider that
doesn't exist. Inventing plausible-sounding escalations from claim *text* (keyword-matching
for "blocked", asking an LLM to judge severity) would mean a second, un-audited system
deciding what's important — the same shape of problem `policy.ts` exists to avoid for
disclosure. **Escalation detection should be deterministic code over structural state,
the same discipline as `respond()`, not a second decision-maker with looser rules.**

So v1 triggers only on what's already real and derivable, nothing invented:

| Rule | Fires when | Real signal it reads |
|---|---|---|
| `ESC-COVERAGE` | a person has `agentDeployed: true` but zero connected real surfaces | `computeCoverage()` — already exists, `coverage.ts` |
| `ESC-STALE-CLAIM` | a person's most recent claim is older than 7 days while `agentDeployed: true` | `claims.derived_at` — already exists |
| `ESC-REPEAT-WITHHOLD` | the same requester has been refused (WONT/CANT) about the same target 3 real audited asks in a row | `audit_log` snapshots — already exists |

Each is a real, honest signal: "this person is supposed to be monitored but isn't," "the
monitoring went quiet," "someone keeps hitting a wall trying to find something out." None
of them require fabricating a claim about work that was never actually observed. The old
rule names (ticket-age, cross-functional dependency) become real once a GitHub/Jira
provider exists — natural follow-on work, not v1.

**Open question for you:** are these three the right first three, or is there a signal
you'd rather see first? Easy to swap before any code exists, much less easy after.

## 3. State machine, replacing the free-text `status`

```
open ──(acknowledge)──▶ acknowledged ──(resolve)──▶ resolved
  └──────────────────────(resolve)───────────────────────┘
```

New columns replace the free-text prose: `status text CHECK (IN ('open','acknowledged','resolved'))`,
`acknowledged_by`/`acknowledged_at`, `resolved_by`/`resolved_at`. The UI still renders
"Acknowledged by Jonas Weber · 3d" — it's just composed from real columns at read time
instead of stored as a sentence, so `ageDays` and the status line are both *derived*, per
rule 6.

**Who may act on one:** whoever is in that escalation's `path`, or anyone whose
`deriveAllowedRoles()` result for that target includes `IT admin` or `Executive` — reusing
the exact function that already closed the identity-spoofing gap in `/api/agent/ask`,
rather than inventing a second authorization check. This is also why `path` needs to
become `{ personId, name }[]` instead of bare name strings — you can't structurally check
"is the actor in this chain" against a name.

## 4. Idempotency

Detection re-runs every time it fires (piggybacked on real activity, see §5) — it must not
spam duplicate rows or silently reopen something a human already resolved. Rule: escalation
`id` is deterministic per `(rule, personId)` — `esc-${rule}-${personId}`. If a row for that
id already exists, detection updates `detail`/`evidence_id` in place but **never touches
`status`** — an acknowledged or resolved escalation stays that way even if the underlying
condition is still technically true. A genuinely new occurrence of the same rule class
after resolution would need its own id (e.g. dated), which is a deliberate v2 problem, not
v1 — starting simple here rather than guessing at a re-open policy nobody's asked for yet.

## 5. When detection runs

No job scheduler exists in this app and adding one is real new infrastructure for a
three-rule v1. Piggyback instead: a `runEscalationChecks(orgId, personId)` call, best-effort
(`Promise.allSettled`-wrapped like `gatherAll`), added right next to the existing
`gatherAll(orgId, targetId, ...)` calls in `/api/query` and `/api/agent/ask` — so an
escalation gets (re-)evaluated exactly when real activity is already being gathered for
that person, no new trigger mechanism required.

## 6. Schema changes

```sql
ALTER TABLE escalations
  DROP COLUMN age_days,                          -- derived from created_at at read time
  ALTER COLUMN status SET DEFAULT 'open',
  ADD CONSTRAINT escalations_status_check CHECK (status IN ('open','acknowledged','resolved')),
  ADD COLUMN acknowledged_by integer REFERENCES people(id),
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN resolved_by integer REFERENCES people(id),
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  -- path stays jsonb, shape changes from string[] to {personId,name}[]

GRANT INSERT, UPDATE ON escalations TO mesh_app;   -- was SELECT-only; still never DELETE —
                                                     -- an escalation, once raised, stays in
                                                     -- history, same as claims/audit.
```

## 7. New endpoints

```
POST /api/escalations/:id/acknowledge   { actorPersonId }
POST /api/escalations/:id/resolve       { actorPersonId }
```
Both: 403 if the actor isn't in `path` and doesn't have `IT admin`/`Executive` via
`deriveAllowedRoles`; 409 if the status transition doesn't make sense (e.g. resolving
something already resolved). `GET /api/escalations` unchanged in shape, just backed by
real derivation instead of static rows.

## 8. Frontend

`Escalations.tsx` gets real Acknowledge/Resolve buttons (permission-gated the same way
`Ask.tsx` already grays out role buttons that don't apply) and a status filter. `OrgGraph.tsx`'s
per-person badge count changes from "all rows for this person" to "status = open" — an
acknowledged item shouldn't keep flagging the org chart.

## 9. What this deliberately doesn't do (yet)

- No new resource providers (GitHub/Jira) — v1 triggers only read state this system
  already, honestly, has.
- No re-open policy for a resolved-but-still-true condition — ships simple, revisited if
  it turns out to matter.
- No notification/paging — this is triage surfaced in the app, not push delivery.
