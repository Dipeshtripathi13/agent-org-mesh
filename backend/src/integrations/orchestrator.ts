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

/** The router's own default "how far back" when a question doesn't imply a time frame at
 *  all (e.g. "what's my latest X", "give me my most recent Y") — generous enough to catch
 *  genuinely recent activity without being a bare, unbounded "everything." Also the
 *  fail-open value used everywhere below a real answer can't be trusted: an unconfigured
 *  provider, a parse failure, or a plain surfaceKey string from a model that ignored the
 *  richer per-surface format. Clamped the same way at both ends — never less than a day
 *  (a window with no history isn't a useful override) and never more than a year (bounds
 *  a single hallucinated `sinceDays` from turning one ask into an unbounded historical
 *  scan of every connected tool).
 */
export const DEFAULT_SINCE_DAYS = 90;
const MIN_SINCE_DAYS = 1;
const MAX_SINCE_DAYS = 365;

function clampSinceDays(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SINCE_DAYS;
  return Math.min(MAX_SINCE_DAYS, Math.max(MIN_SINCE_DAYS, Math.round(n)));
}

/**
 * Parses the tool-selection router's response — meant to be a JSON array of
 * `{surfaceKey, sinceDays}` objects, one per surface the router judged relevant, with
 * `sinceDays` its own inference of how far back to look given the question's phrasing —
 * against the actual candidate set for this ask. Found live, reported directly: a fixed
 * "Today / This week" toggle a person had to manually pick before every question doesn't
 * scale to "hundreds of connected tools," and couldn't express anything more specific
 * than those two options anyway. The router deciding a window per surface, per question,
 * replaces that toggle everywhere it existed rather than sitting alongside it.
 *
 * Fails open on anything unparseable, non-array, or entirely unrecognized: this stage
 * decides which real external calls gatherAll() makes, never what gets disclosed, so the
 * failure mode has to be "gather everything, generously" rather than "silently gather
 * nothing." Tolerates stray prose or markdown fences around the array, and a bare
 * surfaceKey string standing in for a whole `{surfaceKey, sinceDays}` object — a smaller
 * or less capable model (a local Ollama model, say) isn't guaranteed to follow the richer
 * shape exactly, and falling back to the same generous default for that one entry is
 * strictly better than treating the whole response as a parse failure.
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
export function parseRelevantSurfaces(raw: string, candidateKeys: string[]): Map<string, number> {
  const all = new Map(candidateKeys.map((k) => [k, DEFAULT_SINCE_DAYS]));
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return all;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return all;
  }
  if (!Array.isArray(parsed)) return all;
  if (parsed.length === 0) return new Map();
  const selected = new Map<string, number>();
  for (const entry of parsed) {
    if (typeof entry === 'string' && candidateKeys.includes(entry)) {
      selected.set(entry, DEFAULT_SINCE_DAYS);
    } else if (
      entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof (entry as { surfaceKey?: unknown }).surfaceKey === 'string'
      && candidateKeys.includes((entry as { surfaceKey: string }).surfaceKey)
    ) {
      const key = (entry as { surfaceKey: string }).surfaceKey;
      selected.set(key, clampSinceDays((entry as { sinceDays?: unknown }).sinceDays));
    }
  }
  // Every returned entry was unrecognized (hallucinated, or answering against a different
  // candidate list entirely) — a real parsing failure, unlike a deliberate empty array.
  return selected.size > 0 ? selected : all;
}
