import { describe, expect, it } from 'vitest';
import { parseCallToolResult, type RawCallToolResult } from './mcpClient.js';

/**
 * Pure translation from a real MCP CallToolResult to a plain value or a thrown Error —
 * the piece genuinely new to this codebase (every other connector parses a plain
 * res.json() body, not a content-array/isError envelope), so it's the one place a real
 * regression could hide silently. No network, no SDK Client — real fixture shapes only.
 */
describe('parseCallToolResult', () => {
  it('throws with the tool name and error text when isError is true', () => {
    const result: RawCallToolResult = { isError: true, content: [{ type: 'text', text: 'not found' }] };
    expect(() => parseCallToolResult(result, 'list_commits')).toThrow('MCP tool "list_commits" failed: not found');
  });

  it('throws a generic message when isError is true with no content text', () => {
    const result: RawCallToolResult = { isError: true, content: [] };
    expect(() => parseCallToolResult(result, 'list_commits')).toThrow('MCP tool "list_commits" failed: tool call failed');
  });

  it('prefers structuredContent when the tool declares an output schema', () => {
    const result: RawCallToolResult = {
      structuredContent: { sha: 'abc123' },
      content: [{ type: 'text', text: '{"sha":"different"}' }],
    };
    expect(parseCallToolResult(result, 'list_commits')).toEqual({ sha: 'abc123' });
  });

  it('parses the first text content block as JSON when there is no structuredContent', () => {
    const result: RawCallToolResult = { content: [{ type: 'text', text: '[{"sha":"abc123"}]' }] };
    expect(parseCallToolResult(result, 'list_commits')).toEqual([{ sha: 'abc123' }]);
  });

  it('falls back to the raw text when it is not valid JSON', () => {
    const result: RawCallToolResult = { content: [{ type: 'text', text: 'plain text result' }] };
    expect(parseCallToolResult(result, 'some_tool')).toBe('plain text result');
  });

  it('returns null when there is no content and no structuredContent at all', () => {
    const result: RawCallToolResult = {};
    expect(parseCallToolResult(result, 'some_tool')).toBeNull();
  });

  it('a genuine structuredContent of an empty array is respected, not treated as missing', () => {
    const result: RawCallToolResult = { structuredContent: [] };
    expect(parseCallToolResult(result, 'list_commits')).toEqual([]);
  });
});
