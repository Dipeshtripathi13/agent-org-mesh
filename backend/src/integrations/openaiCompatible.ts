import { parseRelevantSurfaces } from './orchestrator.js';
import { formatPriorTurns, wrapUntrustedData, type ActivitySection, type ConversationTurn, type ModelProvider, type SurfaceDescriptor } from './modelProvider.js';

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
 * authorize.
 */

export function openaiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function baseUrl(): string {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/** Pure — the request body a chat-completions call sends. Split out from the actual
 *  fetch so the shape can be unit-tested without a network call. */
export function buildChatCompletionsRequest(prompt: string): { model: string; messages: { role: string; content: string }[]; max_tokens: number } {
  return {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 600,
  };
}

async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set on the backend — add it (and optionally OPENAI_BASE_URL / OPENAI_MODEL for a self-hosted model) to backend/.env and restart the server');
  }
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildChatCompletionsRequest(prompt)),
  });
  if (!res.ok) {
    throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  return text ? text.trim() : '(no response returned)';
}

async function selectRelevantSurfaces(question: string, candidates: SurfaceDescriptor[]): Promise<Set<string>> {
  const keys = candidates.map((c) => c.surfaceKey);
  if (keys.length === 0) return new Set();
  if (!openaiConfigured()) return new Set(keys);

  const listing = candidates.map((c) => `- ${c.surfaceKey}: ${c.reads}`).join('\n');
  let raw: string;
  try {
    raw = await callOpenAI(
      [
        "A question is about to be answered from a person's real, connected work surfaces.",
        'Below is the list of currently connected surfaces and what each one can tell you.',
        'Return ONLY a JSON array of surfaceKey strings for the surfaces plausibly relevant to the question below — no prose, no markdown fences.',
        "If the question is a greeting, small talk, or otherwise isn't actually asking about the person's work, activity, or status, return an empty array [] — don't include a surface just because one exists.",
        'Otherwise, if you are at all unsure whether a surface is relevant, include it. Only exclude a surface you are confident has nothing to do with the question.',
        '',
        wrapUntrustedData('question', question),
        '',
        listing,
      ].join('\n'),
    );
  } catch {
    return new Set(keys); // request error — never let a router failure narrow coverage
  }
  return parseRelevantSurfaces(raw, keys);
}

async function synthesize(personName: string, question: string, sections: ActivitySection[], priorTurns?: ConversationTurn[]): Promise<string> {
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
  ].join('\n'));
}

async function writeClaim(personName: string, digest: string): Promise<string> {
  const text = await callOpenAI([
    `Write ONE concise, factual sentence describing ${personName}'s work today, for a manager status view.`,
    'Base it only on the real activity log below — never invent or infer anything beyond it.',
    'Plain sentence, no bullet points, no preamble, no quotes around it.',
    '',
    wrapUntrustedData('activity-log', digest),
  ].join('\n'));
  return text.replace(/^["']|["']$/g, '').trim();
}

export const openaiCompatibleProvider: ModelProvider = {
  configured: openaiConfigured,
  selectRelevantSurfaces,
  synthesize,
  writeClaim,
};
