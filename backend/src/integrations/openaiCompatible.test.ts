import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChatCompletionsRequest } from './openaiCompatible.js';

/**
 * Pure request-shape logic, split out from the actual fetch specifically so it's
 * testable without a network call — same pure/impure split the rest of integrations/
 * uses (policy.ts stays pure and tested; the I/O around it doesn't).
 */
describe('buildChatCompletionsRequest', () => {
  const originalModel = process.env.OPENAI_MODEL;

  beforeEach(() => {
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    if (originalModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = originalModel;
  });

  it('sends the prompt as a single user message', () => {
    const req = buildChatCompletionsRequest('what is Diego working on?');
    expect(req.messages).toEqual([{ role: 'user', content: 'what is Diego working on?' }]);
  });

  it('falls back to a default model when OPENAI_MODEL is unset', () => {
    const req = buildChatCompletionsRequest('question');
    expect(req.model).toBe('gpt-4o-mini');
  });

  it('uses OPENAI_MODEL when set — this is the entire "point at a local model" mechanism', () => {
    process.env.OPENAI_MODEL = 'llama3.1';
    const req = buildChatCompletionsRequest('question');
    expect(req.model).toBe('llama3.1');
  });

  it('caps max_tokens the same way callClaude does, for parity between providers', () => {
    const req = buildChatCompletionsRequest('question');
    expect(req.max_tokens).toBe(600);
  });

  it('prefers an org credential override over OPENAI_MODEL', () => {
    process.env.OPENAI_MODEL = 'gpt-4o';
    const req = buildChatCompletionsRequest('question', { model: 'llama3.1' });
    expect(req.model).toBe('llama3.1');
  });

  it('falls back to OPENAI_MODEL when the credential override has no model set', () => {
    process.env.OPENAI_MODEL = 'gpt-4o';
    const req = buildChatCompletionsRequest('question', { apiKey: 'org-own-key' });
    expect(req.model).toBe('gpt-4o');
  });
});
