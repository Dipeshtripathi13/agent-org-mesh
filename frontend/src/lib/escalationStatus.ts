import type { Escalation, Person } from './api';

/** Elapsed time since an ISO timestamp, as a short unit — "2h", "3d". */
function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${Math.max(hours, 0)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Renders the same "Acknowledged by X · 2h" prose the old free-text status column used
 *  to hand-author — composed here from real status/actor/timestamp columns instead. */
export function describeEscalationStatus(e: Escalation, peopleById: Map<number, Person>): string {
  if (e.status === 'resolved' && e.resolvedAt) {
    const who = e.resolvedBy != null ? peopleById.get(e.resolvedBy)?.name ?? `person ${e.resolvedBy}` : 'someone';
    return `Resolved by ${who} · ${elapsed(e.resolvedAt)}`;
  }
  if (e.status === 'acknowledged' && e.acknowledgedAt) {
    const who = e.acknowledgedBy != null ? peopleById.get(e.acknowledgedBy)?.name ?? `person ${e.acknowledgedBy}` : 'someone';
    return `Acknowledged by ${who} · ${elapsed(e.acknowledgedAt)}`;
  }
  return `No action recorded · ${e.ageDays}d open`;
}
