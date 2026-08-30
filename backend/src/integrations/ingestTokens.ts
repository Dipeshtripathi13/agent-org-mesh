import crypto from 'node:crypto';
import * as repo from '../db/repo.js';
import type { IngestToken } from '../db/repo.js';

/**
 * Self-service Personal-Access-Token pattern (PostHog/Zapier/Datadog-style) —
 * docs/agent-to-agent-communication.md §13. A person generates their own token here and
 * pastes it into their own tool's hook/telemetry config; the token is the ONLY thing that
 * authenticates a pushed event. Only the SHA-256 hash is ever persisted (repo.insertIngestToken),
 * so a DB dump can never be used to replay as someone else, and the raw value is returned
 * exactly once, at generation time.
 */

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function generateToken(personId: number, label: string): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  const token = `aom_${crypto.randomBytes(24).toString('base64url')}`;
  await repo.insertIngestToken(id, personId, hashToken(token), label);
  return { id, token };
}

export async function listTokens(personId: number): Promise<IngestToken[]> {
  return repo.listIngestTokens(personId);
}

export async function revokeToken(personId: number, tokenId: string): Promise<void> {
  await repo.revokeIngestToken(personId, tokenId);
}

/** The entire authentication boundary for POST /api/ingest/:source — identity is resolved
 *  from the bearer token's hash, never from anything the request body claims. */
export async function resolveToken(rawToken: string): Promise<{ personId: number } | null> {
  return repo.resolveIngestToken(hashToken(rawToken));
}

// Same four functions, account-keyed instead of person-keyed — a personal (no-org)
// account generating its own token for the same self-service push pattern.
export async function generateAccountToken(accountId: number, label: string): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  const token = `aom_${crypto.randomBytes(24).toString('base64url')}`;
  await repo.insertAccountIngestToken(id, accountId, hashToken(token), label);
  return { id, token };
}

export async function listAccountTokens(accountId: number) {
  return repo.listAccountIngestTokens(accountId);
}

export async function revokeAccountToken(accountId: number, tokenId: string): Promise<void> {
  await repo.revokeAccountIngestToken(accountId, tokenId);
}

export async function resolveAccountToken(rawToken: string): Promise<{ accountId: number } | null> {
  return repo.resolveAccountIngestToken(hashToken(rawToken));
}
