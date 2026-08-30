import * as repo from '../db/repo.js';
import type { SurfaceKey } from '../domain/types.js';
import {
  ingestClaudeCodeClaim, ingestCodexClaim, ingestGeminiClaim, ingestGithubClaim, ingestJiraClaim,
  ingestLinearClaim, ingestNotionClaim, ingestConfluenceClaim, ingestAsanaClaim, ingestGitlabClaim,
  ingestHubspotClaim, ingestZendeskClaim, ingestCalendarClaim,
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
 * claude-code, github, codex, and gemini-cli are real and live-verified. jira, linear,
 * notion, confluence, asana, gitlab, hubspot, zendesk, and calendar are real but
 * UNVERIFIED — built the same way, no real account/instance to test against yet (see
 * CLAUDE.md's connector catalog paragraph). Gmail is deliberately NOT a provider here —
 * it stays personal-only (the "Ask yourself" box), never a manager-visible org claim. See
 * the design doc §8 for why. Trello/Airtable/Monday/Figma/Discord are connectable
 * (connectorCatalog.ts) but have no ResourceProvider yet — ingestion deliberately
 * deferred, see connectorCatalog.ts's own module comment.
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
];

const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Best-effort: one provider failing (a locked file, a slow call) never blocks the rest —
 * Promise.allSettled, not Promise.all. Failures are logged, not surfaced to the caller.
 * `since` defaults to today, matching the standing-disclosure flow's existing behavior;
 * pass an older date for a wider window (e.g. a week, for an arbitrary-question ask).
 *
 * `question`, when passed, narrows which connected providers actually run: a router call,
 * through whichever ModelProvider `orgId`'s admin has registered as the org's one real
 * main agent (runtimeProvider.ts::getMainProvider) — Claude, ChatGPT, or a self-hosted
 * model all resolve here identically, no per-vendor branching in this function — reads
 * the question against what each connected surface can tell you and returns only the
 * plausibly relevant ones. So "did Diego touch the calendar today" no longer fires a live
 * GitHub call and a live Jira call for no reason, regardless of which model is the org's
 * main agent. Omit `question`, or the org has no configured/resolvable main provider,
 * and every connected provider runs, exactly as before this existed — the router only
 * ever narrows which real-world calls get made, and fails open whenever it can't decide.
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
    }
  }

  const results = await Promise.allSettled(toRun.map((p) => p.ingest(orgId, personId, since)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error(`resource provider "${toRun[i].surfaceKey}" failed:`, r.reason);
    }
  });
  return toRun.map((p) => p.surfaceKey);
}
