import Anthropic from '@anthropic-ai/sdk';
import { originalFetch } from './outboundHttp.js';
import { DEFAULT_SINCE_DAYS, parseRelevantSurfaces } from './orchestrator.js';
import { formatPriorTurns, safePromptName, wrapUntrustedData, type ActivitySection, type ConversationTurn, type ModelProvider, type ProviderCredentials, type SurfaceDescriptor } from './modelProvider.js';

// The platform-wide default client (env-var key), cached like before. An org with its own
// credentials (ProviderCredentials.apiKey) gets a fresh, uncached client instead — client
// construction does no network I/O, so this costs nothing and needs no cache invalidation.
let client: Anthropic | null = null;

// The SDK's own default is a 10-minute timeout with 2 retries — long enough to hold an ask
// open for half an hour. Every caller already falls back to raw authorized data on failure.
// It enforces this timeout itself (proved against a server that never answers), so it gets the
// unwrapped fetch: the 20s outbound default would otherwise cut every long answer short.
const CLIENT_LIMITS = {
  timeout: 90_000,
  maxRetries: 1,
  fetch: ((...args: Parameters<typeof fetch>) => originalFetch()(...args)) as typeof fetch,
};

function getClient(apiKey?: string): Anthropic | null {
  if (apiKey) return new Anthropic({ apiKey, ...CLIENT_LIMITS });
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (!envKey) return null;
  if (!client) client = new Anthropic({ apiKey: envKey, ...CLIENT_LIMITS });
  return client;
}

export function anthropicConfigured(credentials?: ProviderCredentials): boolean {
  return !!(credentials?.apiKey || process.env.ANTHROPIC_API_KEY);
}

async function callClaude(prompt: string, credentials?: ProviderCredentials): Promise<string> {
  const anthropic = getClient(credentials?.apiKey);
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY is not set on the backend — add it to backend/.env and restart the server');
  }
  const response = await anthropic.messages.create({
    model: credentials?.model || 'claude-sonnet-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = response.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '(no response returned)';
}

/** The fixed "what did you complete today" status check a main agent runs against one
 *  sub-agent. Never invents anything not present in the sections passed in. */
export async function summarizeDailyActivity(personName: string, sections: ActivitySection[]): Promise<string> {
  if (sections.length === 0) {
    throw new Error('no real activity to summarize — connect at least one real source first');
  }
  const body = sections.map((s) => `## ${s.source}\n${s.digest}`).join('\n\n');
  return callClaude([
    `You are writing ${safePromptName(personName)}'s "what did I do today" summary from real activity data.`,
    'Use only what is in the sections below — never invent or infer anything not supported by them.',
    'Write 3-6 concise bullet points, grouped sensibly by source or theme. Plain text, no headers.',
    '',
    wrapUntrustedData('activity-log', body),
  ].join('\n'));
}

/**
 * Writes ONE short, factual sentence from a real activity digest — the org-facing claim
 * text that flows into the deterministic policy engine like any other claim (GitHub,
 * Jira, ...). This function only drafts *content*; it never decides who gets to see it —
 * that stays entirely in policy.ts's respond(), unmodified. Matches the house style of
 * the seeded claims (e.g. "PR#2184 in payments-core is open with one blocking review
 * comment on the saved-card path.").
 */
export async function writeActivityClaim(personName: string, digest: string, credentials?: ProviderCredentials): Promise<string> {
  const text = await callClaude([
    `Write ONE concise, factual sentence describing ${safePromptName(personName)}'s work today, for a manager status view.`,
    'Base it only on the real activity log below — never invent or infer anything beyond it.',
    'Plain sentence, no bullet points, no preamble, no quotes around it.',
    '',
    wrapUntrustedData('activity-log', digest),
  ].join('\n'), credentials);
  return text.replace(/^["']|["']$/g, '').trim();
}

/**
 * Router: decides which of a person's currently connected surfaces are plausibly
 * relevant to a free-text question, before gatherAll() spends a live external API call
 * (GitHub, Jira, ...) on each one. This never touches disclosure — respond() still gates
 * everything gathered here exactly as before, same as a surface that returns nothing.
 * It only decides which real-world calls get made.
 *
 * Fails open at every stage — no key configured, an API error, an unparseable response —
 * because the failure mode for a tool-selection stage has to be "gather everything," the
 * same behavior as before this existed, never "silently gather nothing."
 */
export async function selectRelevantSurfaces(question: string, candidates: SurfaceDescriptor[], credentials?: ProviderCredentials): Promise<Map<string, number>> {
  const keys = candidates.map((c) => c.surfaceKey);
  if (keys.length === 0) return new Map();
  if (!anthropicConfigured(credentials)) return new Map(keys.map((k) => [k, DEFAULT_SINCE_DAYS]));

  const listing = candidates.map((c) => `- ${c.surfaceKey}: ${c.reads}`).join('\n');
  let raw: string;
  try {
    raw = await callClaude(
      [
        "A question is about to be answered from a person's real, connected work surfaces.",
        'Below is the list of currently connected surfaces and what each one can tell you.',
        'Return ONLY a JSON array — no prose, no markdown fences — of objects',
        '`{"surfaceKey": string, "sinceDays": number}`, one per surface plausibly relevant to the question below.',
        '`sinceDays` is how many days back to look, inferred from the question\'s own wording:',
        '"today" -> 1, "this week" -> 7, "this month" -> 30, no time frame stated at all',
        `(e.g. "what's my latest X", "give me my most recent Y") -> ${DEFAULT_SINCE_DAYS}.`,
        "If the question is a greeting, small talk, or otherwise isn't actually asking about the person's work, activity, or status, return an empty array [] — don't include a surface just because one exists.",
        'Otherwise, if you are at all unsure whether a surface is relevant, include it. Only exclude a surface you are confident has nothing to do with the question.',
        '',
        wrapUntrustedData('question', question),
        '',
        wrapUntrustedData('connected-tools', listing),
      ].join('\n'),
      credentials,
    );
  } catch {
    // Claude API error — never let a router failure narrow coverage.
    return new Map(keys.map((k) => [k, DEFAULT_SINCE_DAYS]));
  }
  return parseRelevantSurfaces(raw, keys);
}

/** A free-text question answered against real activity data from every connected
 *  source — the main agent's actual "ask me anything about today" endpoint. Same rule:
 *  answer only from what's in the sections, never invent or infer beyond them. `priorTurns`
 *  — real prior Q&A from the same chat — is safe here for the same reason it's safe
 *  everywhere else: it's already-synthesized text, never raw or withheld claims. */
export async function answerFromActivity(personName: string, question: string, sections: ActivitySection[], priorTurns?: ConversationTurn[], credentials?: ProviderCredentials): Promise<string> {
  if (sections.length === 0) {
    throw new Error('no real activity to answer from — connect at least one real source first');
  }
  const body = sections.map((s) => `## ${s.source}\n${s.digest}`).join('\n\n');
  return callClaude([
    `You are ${safePromptName(personName)}'s aggregator agent, answering a question using only their real, connected activity data below.`,
    'Answer only from what is in the sections below — never invent or infer anything not supported by them.',
    'If the data below does not contain enough to answer, say so plainly rather than guessing.',
    'Be concise and direct.',
    '',
    formatPriorTurns(priorTurns),
    wrapUntrustedData('question', question),
    '',
    wrapUntrustedData('authorized-data', body),
  ].join('\n'), credentials);
}

/** A plain, ungrounded conversation — no "answer only from the data below" constraint, so
 *  it still works with nothing connected. See modelProvider.ts's ModelProvider.converse
 *  doc for why this is a genuinely separate method from answerFromActivity rather than
 *  that function called with an empty sections array, and for what `sections` means here. */
export async function converseFreely(personName: string, question: string, priorTurns?: ConversationTurn[], credentials?: ProviderCredentials, sections?: ActivitySection[]): Promise<string> {
  const body = sections && sections.length > 0 ? sections.map((s) => `## ${s.source}\n${s.digest}`).join('\n\n') : null;
  return callClaude([
    `You are ${safePromptName(personName)}'s own personal assistant, answering directly and conversationally.`,
    'Be concise and helpful.',
    body ? 'Below is what your connected tools returned for this question — real activity where there was any, and an honest "nothing found" note where a tool was checked but had nothing relevant. Use it; never claim a tool listed there isn\'t connected.' : '',
    '',
    formatPriorTurns(priorTurns),
    wrapUntrustedData('question', question),
    ...(body ? ['', wrapUntrustedData('connected-tool-data', body)] : []),
  ].join('\n'), credentials);
}

/** Anthropic's ModelProvider implementation — a thin wrapper, no logic duplicated. */
export const anthropicProvider: ModelProvider = {
  configured: anthropicConfigured,
  selectRelevantSurfaces,
  synthesize: answerFromActivity,
  writeClaim: writeActivityClaim,
  converse: converseFreely,
};
