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
/** Longest event text kept. Summaries are one-line descriptions ("Ran the test suite",
 *  a file path); anything longer is either noise or an attempt to smuggle a paragraph into a
 *  later prompt (release audit SEC-14). */
export const MAX_EVENT_SUMMARY_CHARS = 500;
/** Most recent events rendered into one digest; older ones are counted, not listed. */
export const MAX_DIGEST_EVENTS = 200;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** One line, no control characters, bounded. Collapsing newlines matters: a multi-line
 *  summary could otherwise fake extra "- ..." bullets in the digest a model reads. */
function cleanSummary(value: string): string | null {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_EVENT_SUMMARY_CHARS);
  return cleaned || null;
}

/** A pushed timestamp is the caller's claim. Unparseable → now; in the future → now, so an
 *  event can't be dated past the 90-day retention cleanup (db/retention.ts). */
function occurredAtFrom(value: unknown, now = new Date()): string {
  if (typeof value !== 'string') return now.toISOString();
  const time = Date.parse(value);
  if (Number.isNaN(time) || time > now.getTime() + FUTURE_TOLERANCE_MS) return now.toISOString();
  return new Date(time).toISOString();
}

export function normalizeIngestPayload(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  if (typeof b.tool_name === 'string') {
    if (!NARRATIVE_TOOLS.has(b.tool_name)) return null;
    const input = (b.tool_input as Record<string, unknown>) ?? {};
    if (b.tool_name === 'Bash') {
      const description = typeof input.description === 'string' ? cleanSummary(input.description) : null;
      if (!description) return null;
      return { kind: 'action', summary: description, occurredAt: new Date().toISOString() };
    }
    const filePath = typeof input.file_path === 'string' ? cleanSummary(input.file_path) : null;
    if (!filePath) return null;
    return { kind: 'file', summary: filePath, occurredAt: new Date().toISOString() };
  }

  if ((b.kind === 'action' || b.kind === 'file') && typeof b.summary === 'string') {
    const summary = cleanSummary(b.summary);
    if (!summary) return null;
    return { kind: b.kind, summary, occurredAt: occurredAtFrom(b.occurredAt) };
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

// Account-keyed counterparts — a personal (no-org) account's own pushed activity.
export async function recordAccountEvent(accountId: number, source: string, event: NormalizedEvent): Promise<void> {
  await repo.insertAccountIngestedEvent(crypto.randomUUID(), accountId, {
    source,
    kind: event.kind,
    summary: event.summary,
    occurredAt: event.occurredAt,
  });
}

export async function getAccountEventsSince(accountId: number, source: string, since: Date): Promise<IngestedEvent[]> {
  return repo.getAccountIngestedEventsSince(accountId, source, since);
}

/** Renders a plain bullet list of pushed events — the digest realClaims.ts's
 *  ingestPushedEventsClaim (codex/gemini-cli's real claim pipeline) turns into a claim. */
export function formatIngestedEventsDigest(events: IngestedEvent[]): string | null {
  if (events.length === 0) return null;
  const recent = events.slice(-MAX_DIGEST_EVENTS);
  const omitted = events.length - recent.length;
  const lines = recent.map((e) => `- ${e.summary}`);
  return omitted > 0 ? [`- (${omitted} earlier events not shown)`, ...lines].join('\n') : lines.join('\n');
}
