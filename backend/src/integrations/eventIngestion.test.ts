import { describe, expect, it } from 'vitest';
import { formatIngestedEventsDigest, normalizeIngestPayload } from './eventIngestion.js';
import type { IngestedEvent } from '../db/repo.js';

/**
 * normalizeIngestPayload is the real parsing boundary for POST /api/ingest/:source —
 * arbitrary, attacker-reachable JSON (the bearer token authenticates *who*, this function
 * decides *what*, if anything, gets recorded). Zero tests before this pass despite that.
 */

describe('normalizeIngestPayload — Claude Code native hook shape', () => {
  it('accepts a narrative Bash call with a description', () => {
    const result = normalizeIngestPayload({ tool_name: 'Bash', tool_input: { command: 'npm test', description: 'ran the test suite' } });
    expect(result).toMatchObject({ kind: 'action', summary: 'ran the test suite' });
  });

  it('accepts a narrative Edit call with a file_path', () => {
    const result = normalizeIngestPayload({ tool_name: 'Edit', tool_input: { file_path: 'src/server.ts' } });
    expect(result).toMatchObject({ kind: 'file', summary: 'src/server.ts' });
  });

  it('accepts Write and NotebookEdit the same way as Edit', () => {
    expect(normalizeIngestPayload({ tool_name: 'Write', tool_input: { file_path: 'a.ts' } })).toMatchObject({ kind: 'file', summary: 'a.ts' });
    expect(normalizeIngestPayload({ tool_name: 'NotebookEdit', tool_input: { file_path: 'b.ipynb' } })).toMatchObject({ kind: 'file', summary: 'b.ipynb' });
  });

  it('rejects a non-narrative tool call (e.g. Read) — most hook firings are exactly this', () => {
    expect(normalizeIngestPayload({ tool_name: 'Read', tool_input: { file_path: 'x.ts' } })).toBeNull();
  });

  it('rejects a Bash call with no description, even though the tool_name matches', () => {
    expect(normalizeIngestPayload({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toBeNull();
  });

  it('rejects a Bash call whose description is only whitespace', () => {
    expect(normalizeIngestPayload({ tool_name: 'Bash', tool_input: { description: '   ' } })).toBeNull();
  });

  it('rejects an Edit call missing file_path', () => {
    expect(normalizeIngestPayload({ tool_name: 'Edit', tool_input: {} })).toBeNull();
  });

  it('trims whitespace around the summary', () => {
    const result = normalizeIngestPayload({ tool_name: 'Bash', tool_input: { description: '  padded  ' } });
    expect(result?.summary).toBe('padded');
  });

  it('handles a missing tool_input entirely without throwing', () => {
    expect(normalizeIngestPayload({ tool_name: 'Bash' })).toBeNull();
  });
});

describe('normalizeIngestPayload — generic fallback shape', () => {
  it('accepts a well-formed generic action event', () => {
    const result = normalizeIngestPayload({ kind: 'action', summary: 'did a thing' });
    expect(result?.kind).toBe('action');
    expect(result?.summary).toBe('did a thing');
  });

  it('accepts a well-formed generic file event', () => {
    expect(normalizeIngestPayload({ kind: 'file', summary: 'path/to/file' })?.kind).toBe('file');
  });

  it('uses a caller-supplied occurredAt when it is a string', () => {
    const result = normalizeIngestPayload({ kind: 'action', summary: 'x', occurredAt: '2026-01-01T00:00:00.000Z' });
    expect(result?.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back to now() when occurredAt is missing or the wrong type', () => {
    const before = Date.now();
    const result = normalizeIngestPayload({ kind: 'action', summary: 'x', occurredAt: 12345 });
    expect(result).not.toBeNull();
    expect(new Date(result!.occurredAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('rejects an unrecognized kind value', () => {
    expect(normalizeIngestPayload({ kind: 'delete', summary: 'x' })).toBeNull();
  });

  it('rejects a blank summary', () => {
    expect(normalizeIngestPayload({ kind: 'action', summary: '   ' })).toBeNull();
  });

  it('trims the summary', () => {
    expect(normalizeIngestPayload({ kind: 'action', summary: '  x  ' })?.summary).toBe('x');
  });
});

describe('normalizeIngestPayload — malformed/hostile input never throws', () => {
  it('rejects null', () => {
    expect(normalizeIngestPayload(null)).toBeNull();
  });

  it('rejects undefined', () => {
    expect(normalizeIngestPayload(undefined)).toBeNull();
  });

  it('rejects a bare string body', () => {
    expect(normalizeIngestPayload('just a string')).toBeNull();
  });

  it('rejects a bare number body', () => {
    expect(normalizeIngestPayload(42)).toBeNull();
  });

  it('rejects an array body', () => {
    expect(normalizeIngestPayload([{ kind: 'action', summary: 'x' }])).toBeNull();
  });

  it('rejects an empty object', () => {
    expect(normalizeIngestPayload({})).toBeNull();
  });

  it('rejects a summary that is the wrong type (number instead of string)', () => {
    expect(normalizeIngestPayload({ kind: 'action', summary: 12345 })).toBeNull();
  });

  it('rejects tool_input that is itself an array rather than an object', () => {
    expect(normalizeIngestPayload({ tool_name: 'Bash', tool_input: ['not', 'an', 'object'] })).toBeNull();
  });

  it('ignores unknown extra fields rather than choking on them', () => {
    const result = normalizeIngestPayload({ kind: 'action', summary: 'x', extra: 'field', nested: { a: 1 } });
    expect(result?.summary).toBe('x');
  });
});

describe('formatIngestedEventsDigest', () => {
  const event = (summary: string): IngestedEvent => ({ source: 'codex', kind: 'action', summary, occurredAt: '2026-01-01T00:00:00.000Z' });

  it('renders one bullet per event', () => {
    expect(formatIngestedEventsDigest([event('a'), event('b')])).toBe('- a\n- b');
  });

  it('returns null (not an empty string) for no events — so callers can tell "nothing happened" from "empty digest"', () => {
    expect(formatIngestedEventsDigest([])).toBeNull();
  });
});
