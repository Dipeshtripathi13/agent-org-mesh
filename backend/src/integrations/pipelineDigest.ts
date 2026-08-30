/** Shared "did it run, did it pass" digest — the data-engineering-connectors research
 *  memo's Phase 3: a pipeline run (Airflow DAG run, dbt job run, Snowflake task/query) is
 *  a different shape of activity than "issues assigned to you," so it gets its own shared
 *  formatter instead of three near-duplicate ones. Each connector maps its own API
 *  response into PipelineRunItem[] and calls this; the digest itself is what actually
 *  reads well in an answer ("2 of 14 runs failed" beats a bare list of every run). */
export interface PipelineRunItem {
  name: string;
  status: 'success' | 'failed' | 'running' | 'other';
  finishedAt?: string;
}

export function formatPipelineDigest(items: PipelineRunItem[]): string | null {
  if (items.length === 0) return null;
  const failed = items.filter((i) => i.status === 'failed');
  const succeeded = items.filter((i) => i.status === 'success');
  const running = items.filter((i) => i.status === 'running');
  const summary = `${items.length} run${items.length === 1 ? '' : 's'}: ${succeeded.length} succeeded, ${failed.length} failed`
    + (running.length > 0 ? `, ${running.length} still running` : '') + '.';
  const failedLines = failed.slice(0, 10).map((f) => `- FAILED "${f.name}"${f.finishedAt ? ` (${f.finishedAt})` : ''}`);
  return [summary, ...failedLines].join('\n');
}
