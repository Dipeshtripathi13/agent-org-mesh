import { describe, expect, it } from 'vitest';
import { anthropicProvider } from './anthropic.js';
import { openaiCompatibleProvider } from './openaiCompatible.js';
import { configEnvVarFor, providerForApiFamily } from './runtimeProvider.js';

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
