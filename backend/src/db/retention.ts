import { pool } from './pool.js';

/**
 * Enforces the privacy policy's promise that raw activity pushed by people's own tools (Claude
 * Code, Codex CLI, Gemini CLI, custom agents) is deleted after ACTIVITY_RETENTION_DAYS. The
 * app role was granted DELETE on exactly these two tables for this (migration 0002). Running on
 * several instances at once is harmless: the deletes are idempotent.
 */

export const ACTIVITY_RETENTION_DAYS = 90;

export async function purgeExpiredActivity(
  now: Date = new Date(),
  days: number = ACTIVITY_RETENTION_DAYS,
): Promise<{ personEvents: number; accountEvents: number; cutoff: string }> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const person = await pool.query('DELETE FROM ingested_events WHERE occurred_at < $1', [cutoff]);
  const account = await pool.query('DELETE FROM account_ingested_events WHERE occurred_at < $1', [cutoff]);
  return { personEvents: person.rowCount ?? 0, accountEvents: account.rowCount ?? 0, cutoff };
}

/** First run a minute after start (so it never slows boot), then every six hours. */
export function startActivityRetention(intervalMs = 6 * 60 * 60 * 1000): void {
  const run = async () => {
    try {
      const result = await purgeExpiredActivity();
      console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), source: 'retention', retentionDays: ACTIVITY_RETENTION_DAYS, ...result }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), source: 'retention', error: { message: (err as Error).message } }));
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, intervalMs).unref();
}
