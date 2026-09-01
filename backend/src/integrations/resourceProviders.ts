import * as repo from '../db/repo.js';
import type { SurfaceKey } from '../domain/types.js';
import {
  ingestClaudeCodeClaim, ingestCodexClaim, ingestGeminiClaim, ingestGithubClaim, ingestJiraClaim,
  ingestLinearClaim, ingestNotionClaim, ingestConfluenceClaim, ingestAsanaClaim, ingestGitlabClaim,
  ingestHubspotClaim, ingestZendeskClaim, ingestCalendarClaim,
  ingestAirflowClaim, ingestDbtClaim, ingestSnowflakeClaim, ingestDatabricksClaim,
} from './realClaims.js';
import { getMainProvider } from './runtimeProvider.js';

/**
 * Orchestrator-worker fan-out (docs/agent-to-agent-communication.md §6): each connected
 * surface a person has plugs in here as a ResourceProvider. `gatherAll` runs every
 * connected provider for that person in parallel and lets each one upsert its own real
 * Claim — the existing claims pipeline (respond() in policy.ts) picks the results up
 * exactly like any seeded claim, unmodified. Adding a 14th real provider is exactly this:
 * one more line here, once its own client module and `ingest<Tool>Claim` function exist
 * (realClaims.ts) — this array, `selectRelevantSurfaces`'s routing, and everything
 * downstream needs no other change per tool.
 *
 * claude-code, codex, and gemini-cli are real and live-verified. github's PR/review reads
 * and connect flow are still live-verified; its commit read moved onto GitHub's own
 * official MCP server (github.ts's own module comment) and is UNVERIFIED against a real
 * PAT again until that's re-proven — a deliberately invalid token reaching the real MCP
 * endpoint and failing clean isn't the same as a real round trip. jira and notion are
 * live-verified now too, both against a real user's own account in production rather than
 * a fixture: jira only after that live attempt surfaced a real breaking change (Atlassian
 * had removed POST /rest/api/3/search outright — see jira.ts), notion on plain REST after
 * its MCP path was tried and genuinely failed (notion.ts). linear, confluence, asana,
 * gitlab, hubspot, zendesk, calendar, airflow, dbt, snowflake, and databricks are real but
 * UNVERIFIED — built the same way, no real account/instance to test against yet (see
 * CLAUDE.md's connector catalog paragraph). Gmail is deliberately NOT
 * a provider here — it stays personal-only (the "Ask yourself" box), never a manager-
 * visible org claim. See the design doc §8 for why. Trello/Airtable/Monday/Figma/Discord
 * are connectable (connectorCatalog.ts) but have no ResourceProvider yet — ingestion
 * deliberately deferred, see connectorCatalog.ts's own module comment. airflow/dbt/
 * snowflake/databricks are the data-engineering-connectors research memo's Tier A: bounded
 * status/metadata reads only, never a connector-composed query against real warehouse data
 * — see snowflake.ts's own module comment for why that boundary matters more there than
 * anywhere else in this array.
 */
export interface ResourceProvider {
  surfaceKey: SurfaceKey;
  ingest(orgId: number, personId: number, since: Date): Promise<void>;
}

export const PROVIDERS: ResourceProvider[] = [
  { surfaceKey: 'claude-code', ingest: ingestClaudeCodeClaim },
  { surfaceKey: 'github', ingest: ingestGithubClaim },
  { surfaceKey: 'codex', ingest: ingestCodexClaim },
  { surfaceKey: 'gemini-cli', ingest: ingestGeminiClaim },
  { surfaceKey: 'jira', ingest: ingestJiraClaim },
  { surfaceKey: 'linear', ingest: ingestLinearClaim },
  { surfaceKey: 'notion', ingest: ingestNotionClaim },
  { surfaceKey: 'confluence', ingest: ingestConfluenceClaim },
  { surfaceKey: 'asana', ingest: ingestAsanaClaim },
  { surfaceKey: 'gitlab', ingest: ingestGitlabClaim },
  { surfaceKey: 'hubspot', ingest: ingestHubspotClaim },
  { surfaceKey: 'zendesk', ingest: ingestZendeskClaim },
  { surfaceKey: 'calendar', ingest: ingestCalendarClaim },
  { surfaceKey: 'airflow', ingest: ingestAirflowClaim },
  { surfaceKey: 'dbt', ingest: ingestDbtClaim },
  { surfaceKey: 'snowflake', ingest: ingestSnowflakeClaim },
  { surfaceKey: 'databricks', ingest: ingestDatabricksClaim },
];

const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Best-effort: one provider failing (a locked file, a slow call) never blocks the rest —
 * Promise.allSettled, not Promise.all. Failures are logged, not surfaced to the caller.
 * `since` defaults to today, matching the standing-disclosure flow's existing behavior for
 * the no-question path below — pass an older date to widen that specific fallback.
 *
 * `question`, when passed, narrows which connected providers actually run *and* how far
 * back each one looks: a router call, through whichever ModelProvider `orgId`'s admin has
 * registered as the org's one real main agent (runtimeProvider.ts::getMainProvider) —
 * Claude, ChatGPT, or a self-hosted model all resolve here identically, no per-vendor
 * branching in this function — reads the question against what each connected surface can
 * tell you and returns, per surface, whether it's relevant and how many days back to look
 * (inferred from the question's own phrasing — see modelProvider.ts's
 * `selectRelevantSurfaces` doc and orchestrator.ts's `DEFAULT_SINCE_DAYS`). This replaces a
 * fixed "Today / This week" toggle a person previously picked by hand before every ask:
 * found live, reported directly, that doesn't scale to hundreds of connected tools and
 * can't express anything more specific than those two options anyway — the router deciding
 * a window per tool, per question, does both. So "did Diego touch the calendar today" no
 * longer fires a live GitHub call and a live Jira call for no reason, regardless of which
 * model is the org's main agent, and "what's the latest thing in my GitHub" gets a wider
 * window than "what did I do today" without anyone picking one by hand. Omit `question`,
 * or the org has no configured/resolvable main provider, and every connected provider runs
 * against the caller's own `since` fallback, exactly as before this router existed — it
 * only ever narrows/redirects which real-world calls get made, and fails open (full
 * coverage, the generous default window) whenever it can't decide.
 *
 * Returns the surface keys actually ingested — the caller (server.ts's /api/agent/ask)
 * surfaces this back as `consultedSources`, real proof of which tools the router decided
 * to call for a given question, not just a fire-and-forget side effect anymore.
 */
export async function gatherAll(orgId: number, personId: number, since: Date = startOfToday(), question?: string): Promise<string[]> {
  const person = await repo.getPerson(personId);
  const connected = PROVIDERS.filter((p) => person.surfaces[p.surfaceKey] === 'connected');
  if (connected.length === 0) return [];

  let toRun = connected;
  let sinceDaysByKey: Map<string, number> | null = null;
  if (question?.trim()) {
    const { provider } = await getMainProvider(orgId);
    if (provider?.configured()) {
      const surfaces = await repo.getSurfaces();
      const candidates = connected.map((p) => ({
        surfaceKey: p.surfaceKey as string,
        reads: surfaces.find((s) => s.key === p.surfaceKey)?.reads ?? p.surfaceKey,
      }));
      const relevant = await provider.selectRelevantSurfaces(question, candidates);
      toRun = connected.filter((p) => relevant.has(p.surfaceKey));
      sinceDaysByKey = relevant;
    }
  }

  // Per-surface window when the router decided one; the caller's own `since` fallback
  // otherwise (no question, or no configured router — sinceDaysByKey stays null either way).
  const sinceFor = (surfaceKey: string): Date => {
    const days = sinceDaysByKey?.get(surfaceKey);
    if (days == null) return since;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };

  const results = await Promise.allSettled(toRun.map((p) => p.ingest(orgId, personId, sinceFor(p.surfaceKey))));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error(`resource provider "${toRun[i].surfaceKey}" failed:`, r.reason);
    }
  });
  return toRun.map((p) => p.surfaceKey);
}
