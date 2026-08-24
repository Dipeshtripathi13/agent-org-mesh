import crypto from 'node:crypto';
import * as repo from '../db/repo.js';
import type { IngestedEvent } from '../db/repo.js';

/**
 * The receiving half of the self-service connector (docs/agent-to-agent-communication.md
 * §13): a person's own Claude Code / Codex CLI / Gemini CLI instance pushes activity here
 * itself, from wherever it actually runs — no assumption that the backend and the tool
 * share a filesystem, which is the real limitation of claudeCodeActivity.ts's local
 * session-log read (it only works because this demo happens to run both on one machine).
 */

const NARRATIVE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

export interface NormalizedEvent {
  kind: 'action' | 'file';
  summary: string;
  occurredAt: string;
}

/** Two accepted shapes:
 *  1. Claude Code's native PostToolUse hook payload — { tool_name, tool_input, ... } —
 *     posted verbatim by an `http`-type hook, no transform needed on the user's end.
 *  2. A generic normalized shape — { kind, summary, occurredAt? } — the fallback contract
 *     for Codex CLI, Gemini CLI, or any custom script, since their native hook/OTel
 *     payload shapes vary and aren't all worth bespoke parsing yet.
 *  Returns null for anything unrecognized or for tool calls we don't consider narrative
 *  (mirrors NARRATIVE_TOOLS in claudeCodeActivity.ts) — silently ignored, not an error,
 *  since a hook fires on every tool call and most aren't interesting. */
export function normalizeIngestPayload(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  if (typeof b.tool_name === 'string') {
    if (!NARRATIVE_TOOLS.has(b.tool_name)) return null;
    const input = (b.tool_input as Record<string, unknown>) ?? {};
    if (b.tool_name === 'Bash') {
      const description = input.description;
      if (typeof description !== 'string' || !description.trim()) return null;
      return { kind: 'action', summary: description.trim(), occurredAt: new Date().toISOString() };
    }
    const filePath = input.file_path;
    if (typeof filePath !== 'string' || !filePath.trim()) return null;
    return { kind: 'file', summary: filePath.trim(), occurredAt: new Date().toISOString() };
  }

  if ((b.kind === 'action' || b.kind === 'file') && typeof b.summary === 'string' && b.summary.trim()) {
    return {
      kind: b.kind,
      summary: b.summary.trim(),
      occurredAt: typeof b.occurredAt === 'string' ? b.occurredAt : new Date().toISOString(),
    };
  }

  return null;
}

export async function recordEvent(personId: number, source: string, event: NormalizedEvent): Promise<void> {
  await repo.insertIngestedEvent(crypto.randomUUID(), personId, {
    source,
    kind: event.kind,
    summary: event.summary,
    occurredAt: event.occurredAt,
  });
}

export async function getEventsSince(personId: number, source: string, since: Date): Promise<IngestedEvent[]> {
  return repo.getIngestedEventsSince(personId, source, since);
}

/** Renders a plain bullet list of pushed events — the digest realClaims.ts's
 *  ingestPushedEventsClaim (codex/gemini-cli's real claim pipeline) turns into a claim. */
export function formatIngestedEventsDigest(events: IngestedEvent[]): string | null {
  if (events.length === 0) return null;
  return events.map((e) => `- ${e.summary}`).join('\n');
}
