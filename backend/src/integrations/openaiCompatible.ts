import { DEFAULT_SINCE_DAYS, parseRelevantSurfaces } from './orchestrator.js';
import { formatPriorTurns, wrapUntrustedData, type ActivitySection, type ConversationTurn, type ModelProvider, type ProviderCredentials, type SurfaceDescriptor } from './modelProvider.js';
import { isSafeExternalUrl } from './urlSafety.js';

/**
 * The ModelProvider implementation for anything speaking the OpenAI chat-completions
 * wire format — which, in practice, is ChatGPT *and* almost every open-source or
 * self-hosted inference server (Ollama, vLLM, LM Studio, text-generation-webui, ...).
 * One adapter serves all of them: swapping OPENAI_BASE_URL to point at a local server is
 * the entire "configuration" needed to use a different model, no code change. Deliberately
 * fetch-based rather than a vendor SDK — every one of those servers accepts a plain HTTP
 * POST, so a dependency isn't needed to stay flexible across them.
 *
 * Same house rules as anthropicProvider: never invents beyond what it's given, fails open
 * on any missing config or request error, and never sees anything respond() didn't already
 * authorize. `credentials`, when passed, is an org's own key/endpoint/model — see
 * modelProvider.ts's ProviderCredentials doc — and always wins over the env var default.
 */

export function openaiConfigured(credentials?: ProviderCredentials): boolean {
  return !!(credentials?.apiKey || process.env.OPENAI_API_KEY);
}

function baseUrl(credentials?: ProviderCredentials): string {
  return (credentials?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/** Pure — the request body a chat-completions call sends. Split out from the actual
 *  fetch so the shape can be unit-tested without a network call. */
export function buildChatCompletionsRequest(prompt: string, credentials?: ProviderCredentials): { model: string; messages: { role: string; content: string }[]; max_tokens: number } {
  return {
    model: credentials?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 600,
  };
}

async function callOpenAI(prompt: string, credentials?: ProviderCredentials): Promise<string> {
  const apiKey = credentials?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set on the backend — add it (and optionally OPENAI_BASE_URL / OPENAI_MODEL for a self-hosted model) to backend/.env and restart the server');
  }
  // Re-validated here, not just when the org first saved it (server.ts's POST
  // .../main-agent) — a hostname's DNS answer can change between save and use
  // (rebinding), so a write-time-only check isn't a real guarantee. The platform-wide
  // OPENAI_BASE_URL env var is operator-set and trusted, so only an org's own override is
  // checked. Fails the same way a network error would — every ModelProvider call site
  // already has a fallback for that.
  if (credentials?.baseUrl) {
    const safety = await isSafeExternalUrl(credentials.baseUrl);
    if (!safety.ok) {
      throw new Error(`custom endpoint URL is no longer considered safe to use: ${safety.reason}`);
    }
  }
  const res = await fetch(`${baseUrl(credentials)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildChatCompletionsRequest(prompt, credentials)),
  });
  if (!res.ok) {
    throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  return text ? text.trim() : '(no response returned)';
}

async function selectRelevantSurfaces(question: string, candidates: SurfaceDescriptor[], credentials?: ProviderCredentials): Promise<Map<string, number>> {
  const keys = candidates.map((c) => c.surfaceKey);
  if (keys.length === 0) return new Map();
  if (!openaiConfigured(credentials)) return new Map(keys.map((k) => [k, DEFAULT_SINCE_DAYS]));

  const listing = candidates.map((c) => `- ${c.surfaceKey}: ${c.reads}`).join('\n');
  let raw: string;
  try {
    raw = await callOpenAI(
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
        listing,
      ].join('\n'),
      credentials,
    );
  } catch {
    // request error — never let a router failure narrow coverage
    return new Map(keys.map((k) => [k, DEFAULT_SINCE_DAYS]));
  }
  return parseRelevantSurfaces(raw, keys);
}

async function synthesize(personName: string, question: string, sections: ActivitySection[], priorTurns?: ConversationTurn[], credentials?: ProviderCredentials): Promise<string> {
  if (sections.length === 0) {
    throw new Error('no real activity to answer from — connect at least one real source first');
  }
  const body = sections.map((s) => `## ${s.source}\n${s.digest}`).join('\n\n');
  return callOpenAI([
    `You are ${personName}'s aggregator agent, answering a question using only their real, connected activity data below.`,
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

async function writeClaim(personName: string, digest: string, credentials?: ProviderCredentials): Promise<string> {
  const text = await callOpenAI([
    `Write ONE concise, factual sentence describing ${personName}'s work today, for a manager status view.`,
    'Base it only on the real activity log below — never invent or infer anything beyond it.',
    'Plain sentence, no bullet points, no preamble, no quotes around it.',
    '',
    wrapUntrustedData('activity-log', digest),
  ].join('\n'), credentials);
  return text.replace(/^["']|["']$/g, '').trim();
}

/** A plain, ungrounded conversation — see modelProvider.ts's ModelProvider.converse doc
 *  for why this is a genuinely separate method from synthesize rather than that function
 *  called with an empty sections array, and for what `sections` means here. */
async function converse(personName: string, question: string, priorTurns?: ConversationTurn[], credentials?: ProviderCredentials, sections?: ActivitySection[]): Promise<string> {
  const body = sections && sections.length > 0 ? sections.map((s) => `## ${s.source}\n${s.digest}`).join('\n\n') : null;
  return callOpenAI([
    `You are ${personName}'s own personal assistant, answering directly and conversationally.`,
    'Be concise and helpful.',
    body ? 'Below is what your connected tools returned for this question — real activity where there was any, and an honest "nothing found" note where a tool was checked but had nothing relevant. Use it; never claim a tool listed there isn\'t connected.' : '',
    '',
    formatPriorTurns(priorTurns),
    wrapUntrustedData('question', question),
    ...(body ? ['', wrapUntrustedData('connected-tool-data', body)] : []),
  ].join('\n'), credentials);
}

export const openaiCompatibleProvider: ModelProvider = {
  configured: openaiConfigured,
  selectRelevantSurfaces,
  synthesize,
  writeClaim,
  converse,
};
