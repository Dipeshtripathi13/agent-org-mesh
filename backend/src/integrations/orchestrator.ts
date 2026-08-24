import type { ResponseItem } from '../domain/types.js';

/**
 * The one rule from docs/agent-to-agent-communication.md §5 that matters most: only
 * items respond() actually *allowed* (policyRef === null) may have their text reach an
 * LLM. WONT items from a 'redact' disposition already carry one real, verbatim sentence
 * — correct for a human reading a list, not safe as raw material for a model asked to
 * synthesize an answer, which could reasonably elaborate on it. CANT items are always
 * generic already, but excluded here too for the same reason: don't hand structural
 * refusal text to a generative step at all, just count it.
 */
export function allowedTextOnly(items: ResponseItem[]): { allowed: ResponseItem[]; withheldCount: number } {
  const allowed = items.filter((i) => i.policyRef === null && i.tier !== 'CANT');
  return { allowed, withheldCount: items.length - allowed.length };
}

/**
 * Parses the tool-selection router's response (meant to be a JSON array of surfaceKey
 * strings) against the actual candidate set for this ask. Fails open on anything
 * unparseable, non-array, or entirely unrecognized: this stage decides which real
 * external calls gatherAll() makes, never what gets disclosed, so the failure mode has to
 * be "gather everything" rather than "silently gather nothing." Tolerates stray prose or
 * markdown fences around the array, since a model isn't guaranteed to follow "no prose"
 * instructions exactly.
 *
 * A genuine, well-formed empty array (`[]`) is treated differently from those failure
 * modes — it's the model deliberately saying "none of these are relevant" (e.g. a
 * greeting like "hi", or a question about something no connected surface could speak to),
 * not a parsing failure, and is respected as an empty selection rather than folded into
 * "gather everything." Safe to trust: this only gates whether a surface gets freshly
 * re-read *this turn* (see selectRelevantSurfaces' doc comment in each ModelProvider) —
 * a surface's already-stored claim still reaches disclosure regardless, so an
 * over-narrow empty selection costs freshness, never hides anything. Found live: "hi"
 * was triggering a real Claude Code re-read and showing up in CONSULTED, because this
 * function used to treat the router's own explicit "[]" the same as it not answering at
 * all.
 */
export function parseRelevantSurfaces(raw: string, candidateKeys: string[]): Set<string> {
  const all = new Set(candidateKeys);
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return all;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return all;
  }
  if (!Array.isArray(parsed)) return all;
  if (parsed.length === 0) return new Set();
  const selected = new Set(parsed.filter((k): k is string => typeof k === 'string' && all.has(k)));
  // Every returned key was unrecognized (hallucinated, or answering against a different
  // candidate list entirely) — a real parsing failure, unlike a deliberate empty array.
  return selected.size > 0 ? selected : all;
}
