import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60_000;

/**
 * A genuinely live, synchronous question answered by the user's own already-authenticated
 * `claude` CLI, shelled out to as a subprocess — not the Agent SDK (which requires its own
 * paid ANTHROPIC_API_KEY and, per Anthropic's own docs, is explicitly barred from reusing
 * claude.ai subscription login for third-party products). The CLI's headless mode (`-p`)
 * reads the same subscription OAuth credentials as interactive use, by design — see
 * docs/agent-to-agent-communication.md for the research trail.
 *
 * This is a different kind of signal than everything else in claudeCodeActivity.ts: that
 * reads what a session *already did* (a transcript, a fact). This spawns a fresh agent to
 * *investigate right now* (git log, file reads) and report what it finds — still real,
 * still grounded in actual tool calls, just not a historical record. Callers must label it
 * as a live investigation, not as "what you did today".
 */

// Only ever caches a positive result. Found and fixed during a later audit: the original
// version cached `false` just as permanently as `true`, for the lifetime of the backend
// process — meaning if the CLI wasn't on PATH the first time this was checked (exactly
// what happened earlier the same day this file was written: a backend process started
// before the user's PATH picked up a fresh `claude` install), the feature would report
// "not installed" forever afterward, even once it genuinely became available, until a
// full restart. Once truly available, a CLI binary isn't going to become unavailable
// mid-process, so only that direction is safe to cache; re-checking a likely-still-true
// negative is cheap (a 5s-capped `--version` call) next to askClaudeCli's own real LLM
// call, so there's no real cost to not caching it.
let confirmedAvailable = false;

/** Strips any inherited ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN before spawning — the CLI's
 *  own docs warn that a present API key silently overrides subscription login in
 *  non-interactive mode. This is the one thing that must never leak into the subprocess. */
function subscriptionOnlyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export async function claudeCliAvailable(): Promise<boolean> {
  if (confirmedAvailable) return true;
  try {
    await execFileAsync('claude', ['--version'], { timeout: 5_000, env: subscriptionOnlyEnv() });
    confirmedAvailable = true;
    return true;
  } catch {
    return false;
  }
}

export interface CliAskResult {
  text: string;
}

/** Read-only, headless, no interactive approval prompts — `--allowedTools` is deliberately
 *  narrow (never Bash/Write/Edit) so a live "ask" can inspect a directory but never act on
 *  it, matching CLAUDE.md's read-only-system rule at the process level, not just in copy. */
export async function askClaudeCli(prompt: string, cwd: string): Promise<CliAskResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read,Grep,Glob',
    ], { cwd, env: subscriptionOnlyEnv(), timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 }));
  } catch (err: any) {
    if (err?.killed) throw new Error('claude CLI timed out after 60s');
    throw new Error(`claude CLI failed: ${err?.stderr || err?.message || 'unknown error'}`);
  }

  let parsed: { result?: string; is_error?: boolean };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('claude CLI returned unparseable output');
  }
  if (parsed.is_error || !parsed.result) throw new Error('claude CLI reported an error');
  return { text: parsed.result };
}
