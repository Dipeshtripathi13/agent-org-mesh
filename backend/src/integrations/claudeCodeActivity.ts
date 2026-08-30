import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { getEventsSince, getAccountEventsSince } from './eventIngestion.js';

/**
 * Real signal, not simulated: Claude Code writes a .jsonl transcript per session under
 * ~/.claude/projects/<cwd-with-slashes-as-dashes>/. This reads this project's own
 * sessions since a given moment and extracts the narrative tool calls (commands run,
 * files edited) — the same shape of information you'd see scrolling back through the
 * session.
 *
 * That local-file read only works because the backend happens to run on the same machine
 * as the session — true for this demo, false for a real user. `personId`, when passed,
 * additionally merges in anything pushed via POST /api/ingest/claude-code (a self-service
 * token + hook, see eventIngestion.ts and docs/agent-to-agent-communication.md §13) —
 * real activity from a Claude Code instance running anywhere, not just here.
 */

// Claude Code's own slugging: every non-alphanumeric character becomes a dash — not just
// path separators, underscores too (org_agent → org-agent).
export const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PROJECT_SLUG = PROJECT_ROOT.replace(/[^a-zA-Z0-9]/g, '-');
const SESSIONS_DIR = path.join(homedir(), '.claude', 'projects', PROJECT_SLUG);

const NARRATIVE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);
const MAX_ACTIONS = 80;
const MAX_FILES = 60;

export interface ClaudeCodeActivity {
  available: boolean;
  sessionCount: number;
  filesTouched: string[];
  actions: string[];
}

const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** since defaults to the start of today — existing callers (the personal "Ask Claude"
 *  box, the per-sub-agent status query) keep behaving exactly as before. Pass an older
 *  `since` (e.g. seven days back) for a wider window, like a weekly manager report.
 *  `personId`, when passed, additionally merges in pushed events for this person — see
 *  the module comment above. `accountId` is the same idea for a personal (no-org)
 *  account's own pushed events — never both at once, since an org-chart person and a
 *  personal account are two different kinds of caller. */
export async function getClaudeCodeActivitySince(since: Date = startOfToday(), personId?: number, accountId?: number): Promise<ClaudeCodeActivity> {
  const files = new Set<string>();
  const actions: string[] = [];
  let sessionCount = 0;
  let localAvailable = false;

  let entries: string[] = [];
  try {
    entries = await readdir(SESSIONS_DIR);
    localAvailable = true;
  } catch {
    // No local session log on this machine — fine, pushed events (below) may still cover it.
  }

  for (const name of entries.filter((f) => f.endsWith('.jsonl'))) {
    const filePath = path.join(SESSIONS_DIR, name);

    // Cheap skip: a file whose last write predates the window can't contain anything in it.
    const stats = await stat(filePath).catch(() => null);
    if (!stats || stats.mtime < since) continue;

    let sawAny = false;
    const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const ts: string | undefined = entry.timestamp;
      if (!ts || new Date(ts) < since) continue;

      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || !NARRATIVE_TOOLS.has(block.name)) continue;
        sawAny = true;
        const input = block.input ?? {};
        if (block.name === 'Bash') {
          // `description` isn't always present in every real transcript — depends on the
          // client recording the tool call (a standalone `claude` CLI session reliably
          // includes it; other Claude Code hosts have been observed not to). Falling back
          // to the command itself means a real Bash call still becomes a real, honest
          // narrative line instead of silently vanishing and understating what actually
          // happened — found live testing this exact gap: 10 real Bash calls in a single
          // session, zero surfaced, because none had a description.
          const label = input.description || (typeof input.command === 'string' ? input.command.split('\n')[0].slice(0, 100) : null);
          if (label) actions.push(String(label));
        } else if (input.file_path) {
          files.add(String(input.file_path));
        }
      }
    }
    rl.close();
    if (sawAny) sessionCount += 1;
  }

  let pushedCount = 0;
  if (personId != null) {
    const pushed = await getEventsSince(personId, 'claude-code', since);
    for (const e of pushed) {
      pushedCount += 1;
      if (e.kind === 'file') files.add(e.summary);
      else actions.push(e.summary);
    }
  }
  if (accountId != null) {
    const pushed = await getAccountEventsSince(accountId, 'claude-code', since);
    for (const e of pushed) {
      pushedCount += 1;
      if (e.kind === 'file') files.add(e.summary);
      else actions.push(e.summary);
    }
  }

  return {
    // Real activity was found either on this machine or pushed from wherever it actually
    // ran — either one is enough to call it "available".
    available: localAvailable || pushedCount > 0,
    sessionCount,
    // Keep the most recent entries, not the first — pushed events are appended after the
    // local scan, so a naive slice(0, MAX) would silently drop them whenever the local log
    // alone already fills the cap. `.at(-1)` (used for "most recently: ...") stays correct
    // either way since these are the tail of the array.
    filesTouched: [...files].slice(-MAX_FILES),
    actions: actions.slice(-MAX_ACTIONS),
  };
}

/** Kept as a convenience alias — same as calling with no `since` argument. */
export const getTodaysClaudeCodeActivity = (personId?: number, accountId?: number) => getClaudeCodeActivitySince(undefined, personId, accountId);

export function formatClaudeCodeDigest(activity: ClaudeCodeActivity): string | null {
  if (!activity.available || (activity.actions.length === 0 && activity.filesTouched.length === 0)) return null;
  const lines: string[] = [];
  if (activity.actions.length) {
    lines.push('Actions taken:');
    for (const a of activity.actions) lines.push(`- ${a}`);
  }
  if (activity.filesTouched.length) {
    lines.push('', 'Files edited or created:');
    for (const f of activity.filesTouched) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}
