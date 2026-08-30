import type { api, ResponseItem } from './api';

/**
 * Pure logic behind "My agent" → "Ask yourself" (MyAgent.tsx) — reconstructing a chat's
 * turns from the real audit log, and formatting when a chat was last touched. Extracted
 * out of the page component so it's unit-testable the same way deriveAllowedRoles
 * (roles.ts) and escalation status text (escalationStatus.ts) already are.
 */

export interface AskResult {
  answer: string;
  items: ResponseItem[];
  withheldCount: number;
  coverage: { text: string };
  /** Real tools the router decided to call for this turn's question (e.g. ["Claude Code",
   *  "Gmail"]) — empty when the answer came purely from what was already on file. */
  consultedSources: string[];
}

export interface ThreadTurn {
  id: string;
  question: string;
  result: AskResult | null;
  error: string | null;
  busy: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
}

export type RawEntry = Awaited<ReturnType<typeof api.auditForSubject>>['entries'][number];

/** Every "Self" ask — whether asked from this box or from the real Ask page with
 *  yourself as the target — is already a real, persisted audit_log row with its
 *  synthesized answer stored in the snapshot. That's the actual, durable history;
 *  reconstructing a chat's turns from it means "preserve the conversation" needs no
 *  separate storage of its own, and it's the same real record across devices/browsers,
 *  not a local-only copy. withheldCount isn't stored on the snapshot itself (it's a
 *  derived count the live /agent/ask response computes), so it's recomputed here the
 *  same way allowedTextOnly() does on the backend. */
export function turnFromAuditEntry(entry: RawEntry): ThreadTurn {
  const items = entry.snapshot.items;
  const withheldCount = items.filter((i) => i.tier === 'CANT' || i.policyRef !== null).length;
  return {
    id: entry.id,
    question: entry.question,
    result: {
      answer: entry.snapshot.synthesizedAnswer ?? items.filter((i) => i.policyRef === null && i.tier !== 'CANT').map((i) => i.text).join('\n'),
      items,
      withheldCount,
      coverage: entry.snapshot.coverage,
      consultedSources: entry.snapshot.consultedSources ?? [],
    },
    error: null,
    busy: false,
  };
}

export type RawPersonalEntry = Awaited<ReturnType<typeof api.personalAsks>>['entries'][number];

/** The personal counterpart to turnFromAuditEntry, for an account with no organization.
 *  A personal ask was never about disclosure — no claims, no policy engine, no coverage —
 *  so `items`/`withheldCount`/`coverage` are left at their "nothing to show" defaults
 *  rather than faked; MyAgent.tsx's turn renderer skips those sub-sections whenever
 *  `items` is empty and `coverage.text` is blank. `consultedSources` is real, though: the
 *  personal ask-bridge's own router decision (server.ts's ask-personal), same meaning as
 *  the org path's own consultedSources. */
export function turnFromPersonalEntry(entry: RawPersonalEntry): ThreadTurn {
  return {
    id: entry.id,
    question: entry.question,
    result: {
      answer: entry.answer,
      items: [],
      withheldCount: 0,
      coverage: { text: '' },
      consultedSources: entry.consultedSources ?? [],
    },
    error: null,
    busy: false,
  };
}

/** `now` is injectable so tests don't race the real clock. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
