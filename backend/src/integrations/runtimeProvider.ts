import * as repo from '../db/repo.js';
import type { ApiFamily } from '../domain/types.js';
import { anthropicProvider } from './anthropic.js';
import type { ModelProvider } from './modelProvider.js';
import { openaiCompatibleProvider } from './openaiCompatible.js';

/**
 * Pure mapping from a catalog entry's api_family to the concrete adapter that answers
 * for it. This — not a per-vendor if/else scattered through server.ts — is what makes
 * adding a new supported vendor a one-line seed-data change plus, at most, one new
 * adapter file, never a change to every call site that asks a question.
 */
export function providerForApiFamily(apiFamily: ApiFamily | string): ModelProvider | null {
  switch (apiFamily) {
    case 'anthropic':
      return anthropicProvider;
    case 'openai-compatible':
      return openaiCompatibleProvider;
    default:
      return null; // 'unsupported', or any unrecognized value — no real integration path
  }
}

/** Which env var a caller should point someone at when a resolved provider isn't
 *  configured — kept alongside the mapping above so the two never drift apart. */
export function configEnvVarFor(apiFamily: ApiFamily | string): string | null {
  switch (apiFamily) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai-compatible':
      return 'OPENAI_API_KEY';
    default:
      return null;
  }
}

export interface MainProviderResolution {
  provider: ModelProvider | null;
  runtimeName: string | null;
  apiFamily: string | null;
  configEnvVar: string | null;
}

/**
 * Resolves whichever model actually answers for `orgId` right now — reads the org's one
 * real `org_main_agent` registration (admin-set, shared by everyone in the org), not a
 * hardcoded vendor. Used everywhere in the ask pipeline with the TARGET's org: the
 * organization's own agent does the analyzing and aggregating for every person in it,
 * the same org whose tools gatherAll() invokes.
 *
 * Returns nulls (never throws) when the org has no main agent set, an unrecognized
 * catalog key, or an `unsupported` api_family — callers already have a graceful "not
 * configured" fallback path built for the single-vendor case; this just makes it
 * vendor-aware.
 */
export async function getMainProvider(orgId: number): Promise<MainProviderResolution> {
  const [main, catalog] = await Promise.all([repo.getOrgMainAgent(orgId), repo.getRuntimeCatalog()]);
  const runtime = main ? (catalog.find((c) => c.key === main.runtimeKey) ?? null) : null;
  if (!runtime) return { provider: null, runtimeName: null, apiFamily: null, configEnvVar: null };
  return {
    provider: providerForApiFamily(runtime.apiFamily),
    runtimeName: runtime.name,
    apiFamily: runtime.apiFamily,
    configEnvVar: configEnvVarFor(runtime.apiFamily),
  };
}
