import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../domain/crypto.js';
import type { OrgMainAgent } from '../domain/types.js';
import { anthropicProvider } from './anthropic.js';
import { openaiCompatibleProvider } from './openaiCompatible.js';
import { configEnvVarFor, providerForApiFamily, resolveCredentials } from './runtimeProvider.js';

function mainAgent(overrides: Partial<OrgMainAgent> = {}): OrgMainAgent {
  return {
    runtimeKey: 'claude-sonnet',
    scope: 'full',
    addedAt: '2026-01-01',
    apiKeyEncrypted: null,
    baseUrl: null,
    model: null,
    ...overrides,
  };
}

/**
 * This mapping is what lets adding a supported vendor be a one-line seed-data change
 * (api_family on a runtime_catalog row) rather than a new branch in every call site that
 * asks a question. Pure, no I/O — worth pinning down exactly.
 */
describe('providerForApiFamily', () => {
  it('resolves "anthropic" to the anthropic provider', () => {
    expect(providerForApiFamily('anthropic')).toBe(anthropicProvider);
  });

  it('resolves "openai-compatible" to the openai-compatible provider', () => {
    expect(providerForApiFamily('openai-compatible')).toBe(openaiCompatibleProvider);
  });

  it('resolves "unsupported" to null — no real adapter, stays a simulation', () => {
    expect(providerForApiFamily('unsupported')).toBeNull();
  });

  it('resolves any unrecognized string to null rather than throwing', () => {
    expect(providerForApiFamily('some-future-vendor')).toBeNull();
  });
});

describe('configEnvVarFor', () => {
  it('names ANTHROPIC_API_KEY for the anthropic family', () => {
    expect(configEnvVarFor('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('names OPENAI_API_KEY for the openai-compatible family', () => {
    expect(configEnvVarFor('openai-compatible')).toBe('OPENAI_API_KEY');
  });

  it('is null for unsupported or unrecognized families — nothing to configure', () => {
    expect(configEnvVarFor('unsupported')).toBeNull();
    expect(configEnvVarFor('anything-else')).toBeNull();
  });

  it('never drifts from providerForApiFamily: every family with a real provider also has a configEnvVar, and vice versa', () => {
    for (const family of ['anthropic', 'openai-compatible', 'unsupported'] as const) {
      const hasProvider = providerForApiFamily(family) !== null;
      const hasEnvVar = configEnvVarFor(family) !== null;
      expect(hasProvider).toBe(hasEnvVar);
    }
  });
});

describe('resolveCredentials', () => {
  const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
  });

  it('returns undefined when there is no main agent — nothing to override', () => {
    expect(resolveCredentials(null)).toBeUndefined();
  });

  it('returns undefined when the org set no override — falls through to the env var default', () => {
    expect(resolveCredentials(mainAgent())).toBeUndefined();
  });

  it('decrypts a stored api key into the plain credential the adapters expect', () => {
    const stored = encryptSecret('sk-org-own-key');
    const credentials = resolveCredentials(mainAgent({ apiKeyEncrypted: stored }));
    expect(credentials?.apiKey).toBe('sk-org-own-key');
  });

  it('carries baseUrl and model through untouched — never secrets, never encrypted', () => {
    const credentials = resolveCredentials(mainAgent({ baseUrl: 'https://llm.example.internal/v1', model: 'llama3.1' }));
    expect(credentials).toEqual({ baseUrl: 'https://llm.example.internal/v1', model: 'llama3.1' });
  });

  it('falls back to no override (not a crash) when the encryption key changed since the key was stored', () => {
    const stored = encryptSecret('sk-org-own-key');
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64'); // rotated
    const credentials = resolveCredentials(mainAgent({ apiKeyEncrypted: stored }));
    expect(credentials?.apiKey).toBeUndefined();
  });
});
