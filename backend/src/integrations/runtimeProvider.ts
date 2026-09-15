import { decryptSecret } from '../domain/crypto.js';
import * as repo from '../db/repo.js';
import type { ApiFamily } from '../domain/types.js';
import { anthropicProvider } from './anthropic.js';
import type { ModelProvider, ProviderCredentials } from './modelProvider.js';
import { openaiCompatibleProvider } from './openaiCompatible.js';

/** Structural shape shared by OrgMainAgent and AccountMainAgent — resolveCredentials only
 *  ever reads these four fields, so it works unmodified for either without importing both
 *  concrete types. */
interface MainAgentCredentialSource {
  runtimeKey: string;
  apiKeyEncrypted: string | null;
  baseUrl: string | null;
  model: string | null;
}

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

/** Turns an org's optional stored credential override into the ProviderCredentials shape
 *  every adapter accepts, decrypting the API key if one is set. Absent fields mean "fall
 *  back to this deployment's env var default" — the adapters handle that half. Returns
 *  undefined when nothing is overridden, so bindCredentials can skip wrapping entirely
 *  for the common case (an org using the platform default, unchanged behavior).
 *  Deterministic and synchronous (still safely unit-testable without mocking I/O) but not
 *  side-effect-free — a decryption failure logs via console.error, see below. */
export function resolveCredentials(main: MainAgentCredentialSource | null): ProviderCredentials | undefined {
  if (!main) return undefined;
  if (!main.apiKeyEncrypted && !main.baseUrl && !main.model) return undefined;
  const credentials: ProviderCredentials = {};
  if (main.apiKeyEncrypted) {
    try {
      credentials.apiKey = decryptSecret(main.apiKeyEncrypted);
    } catch (err) {
      // A decryption failure (rotated CREDENTIAL_ENCRYPTION_KEY, corrupted row) must never
      // crash an ask — fall back to the platform default, same as no override being set.
      // Still logged (found missing during a security audit): silently reverting to the
      // platform default is the right behavior, but it should never be invisible — an
      // admin whose org quietly stopped using its own key deserves a signal in the logs,
      // not just a puzzling change in which provider answered.
      console.error({ err, orgRuntimeKey: main.runtimeKey }, 'org credential decryption failed — falling back to the platform default provider');
    }
  }
  if (main.baseUrl) credentials.baseUrl = main.baseUrl;
  if (main.model) credentials.model = main.model;
  return credentials;
}

/** Closes over a resolved credential override so every one of ModelProvider's methods
 *  forwards it automatically — the 5 existing call sites (server.ts's /api/agent/ask,
 *  realClaims.ts's 4 ingestion functions) never need to know credentials exist at all. */
function bindCredentials(provider: ModelProvider, credentials: ProviderCredentials | undefined): ModelProvider {
  if (!credentials) return provider;
  return {
    configured: () => provider.configured(credentials),
    selectRelevantSurfaces: (question, candidates) => provider.selectRelevantSurfaces(question, candidates, credentials),
    synthesize: (personName, question, sections, priorTurns) => provider.synthesize(personName, question, sections, priorTurns, credentials),
    writeClaim: (personName, digest) => provider.writeClaim(personName, digest, credentials),
    converse: (personName, question, priorTurns, _credentials, sections) => provider.converse(personName, question, priorTurns, credentials, sections),
    combineAnswers: (askerName, question, answers) => provider.combineAnswers(askerName, question, answers, credentials),
  };
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
  const baseProvider = providerForApiFamily(runtime.apiFamily);
  return {
    provider: baseProvider ? bindCredentials(baseProvider, resolveCredentials(main)) : null,
    runtimeName: runtime.name,
    apiFamily: runtime.apiFamily,
    configEnvVar: configEnvVarFor(runtime.apiFamily),
  };
}

/**
 * The personal counterpart to getMainProvider — resolves whichever model answers for an
 * account with no organization, from its own `account_main_agent` registration
 * (self-set, see server.ts's POST /api/accounts/me/main-agent) instead of an org's shared
 * one. Same resolution shape, same graceful-null behavior when nothing's registered yet.
 */
export async function getPersonalMainProvider(accountId: number): Promise<MainProviderResolution> {
  const [main, catalog] = await Promise.all([repo.getAccountMainAgent(accountId), repo.getRuntimeCatalog()]);
  const runtime = main ? (catalog.find((c) => c.key === main.runtimeKey) ?? null) : null;
  if (!runtime) return { provider: null, runtimeName: null, apiFamily: null, configEnvVar: null };
  const baseProvider = providerForApiFamily(runtime.apiFamily);
  return {
    provider: baseProvider ? bindCredentials(baseProvider, resolveCredentials(main)) : null,
    runtimeName: runtime.name,
    apiFamily: runtime.apiFamily,
    configEnvVar: configEnvVarFor(runtime.apiFamily),
  };
}
