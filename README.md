# Eternity Nest

Every person gets one aggregator agent that knows their working context. Agents answer
questions across and up the org chart, so the coordination overhead humans carry —
status updates, "any update on X?", escalations — is absorbed by software.

**Read-only.** The system never writes to any connected surface.

## Run it

Requires Docker for Postgres.

```bash
cd backend && npm install
npm run db:up && npm run db:migrate && npm run db:seed   # Postgres on :5433
npm run dev                                               # http://localhost:3001
```
```bash
cd frontend && npm install && npm run dev    # http://localhost:5173
```

Open http://localhost:5173.

## Tests

```bash
cd backend && npm test
```

127 golden tests covering policy determinism, the role × disposition matrix, coverage
arithmetic, audit hash-chain integrity and tamper detection, escalation detection rules,
and the LLM-synthesis redaction filter. This suite is the artifact to hand a security
reviewer — it demonstrates that disclosure decisions are deterministic and that the log
cannot be rewritten.

## What's built

| Area | State |
|---|---|
| Policy engine (deterministic, 6 roles × 3 classes) | working |
| Coverage computation (weighted, scope-aware) | working |
| Append-only hash-chained audit with policy revisions | working |
| Admin: Overview, Coverage matrix, Policy matrix, Audit log | working |
| Employee: My agent with live role preview | working |
| Multi-org: one admin, several organizations, build a chart from scratch | working — `Admin → Organizations` |
| Escalation triage | working — see `docs/escalation-triage.md` |
| Postgres persistence | working — `docker-compose.yml` + `backend/db/schema.sql` |
| Self-service connectors (Claude Code, GitHub, Codex CLI, Gemini CLI) | working, live-verified — see `docs/agent-to-agent-communication.md` §13 |
| Real live CLI ask (Claude Code, via your own subscription login) | working, live-verified |
| Real Jira connector | built, unverified — no real instance available yet, see CLAUDE.md |
| Salesforce | seeded data only, no real connector yet |

## Try this first

1. **Policy matrix** → set *Peer × Internal* to **Refuse visibly**.
2. The test panel on the right updates immediately — the answer is generated from the
   grid as it stands, against the target's real coverage.
3. Switch the target to **Ruben Castellanos** (40% coverage). Claims whose backing
   surface is disconnected are not asserted, and the coverage line names what's missing.
4. **Audit log** → expand the seeded entry. It still shows what was returned under the
   *earlier* revision, with a notice that policy has since changed.

That last step is the whole point. An audit log that changes retroactively isn't one.
