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

const NARRATIVE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

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

/** Masks the credential shapes most likely to appear in a shell command line. A command is
 *  only ever used when the tool gave no description (Codex never does), and even then only
 *  its first line; this catches the obvious leaks, it is not a guarantee. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ao[ivr]_[A-Za-z0-9_-]{20,}|lin_api_[A-Za-z0-9]{16,}|ntn_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi, '$1[redacted]')
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s'"]+/gi, '$1[redacted]')
    .replace(/(-u\s+[^\s:]+:)[^\s'"]+/g, '$1[redacted]')
    // user:password@ in any URL scheme — postgres://, mongodb+srv://, redis://, https://
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/gi, '$1[redacted]@');
}

/** Paths are reported relative to the project the tool ran in, so a manager never sees the
 *  person's username or folder layout (end-to-end test, 2026-09-13). A path outside the
 *  project keeps only its last two segments. */
export function relativePath(filePath: string, cwd: unknown): string {
  const root = typeof cwd === 'string' && cwd.startsWith('/') ? cwd.replace(/\/+$/, '') : null;
  if (root && filePath.startsWith(`${root}/`)) return filePath.slice(root.length + 1);
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  return filePath;
}

/** Codex's apply_patch sends the whole patch as `command`; only the file names are kept. */
function patchedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(m[1].trim());
  return files;
}

export function normalizeIngestPayload(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // Claude Code and Codex both send this PostToolUse hook shape. Codex omits `description`
  // on shell calls and edits files with `apply_patch`; before 2026-09-14 both were accepted
  // and silently discarded, so Codex never recorded anything (end-to-end test, 2026-09-13).
  if (typeof b.tool_name === 'string') {
    if (!NARRATIVE_TOOLS.has(b.tool_name)) return null;
    const input = b.tool_input && typeof b.tool_input === 'object' && !Array.isArray(b.tool_input)
      ? (b.tool_input as Record<string, unknown>) : {};
    const now = new Date().toISOString();
    if (b.tool_name === 'Bash') {
      const description = typeof input.description === 'string' ? cleanSummary(input.description) : null;
      if (description) return { kind: 'action', summary: description, occurredAt: now };
      const firstLine = typeof input.command === 'string' ? input.command.split('\n').find((l) => l.trim()) : undefined;
      const command = firstLine ? cleanSummary(`Ran: ${redactSecrets(firstLine.trim()).slice(0, 160)}`) : null;
      return command ? { kind: 'action', summary: command, occurredAt: now } : null;
    }
    if (b.tool_name === 'apply_patch') {
      const files = typeof input.command === 'string' ? patchedFiles(input.command).map((f) => relativePath(f, b.cwd)) : [];
      const summary = files.length ? cleanSummary(files.join(', ')) : null;
      return summary ? { kind: 'file', summary, occurredAt: now } : null;
    }
    const filePath = typeof input.file_path === 'string' ? cleanSummary(relativePath(input.file_path, b.cwd)) : null;
    if (!filePath) return null;
    return { kind: 'file', summary: filePath, occurredAt: now };
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
