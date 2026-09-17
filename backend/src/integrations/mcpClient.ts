/** A small, generic MCP client helper — the shared foundation any future MCP-backed
 *  connector reuses, the same way genericConnection.ts is already reused by every
 *  PAT-based one. Deliberately session-scoped, not connect-per-call: a single digest fetch
 *  can make many tool calls (github.ts's own commit read does one per relevant repo), and
 *  reopening a fresh MCP session — a real `initialize` handshake — for each one would be
 *  wasteful against a remote server. `withMcpSession` opens exactly one session per
 *  invocation, hands the caller a bound `callTool`, and always closes it — never a
 *  module-level singleton, since every call here is for a different person's own bearer
 *  credential and a session must never be shared across two people's tokens.
 *
 *  Deliberately does NOT expose `listTools()` or any other discovery surface to callers —
 *  every connector built on this decides its own allowlist of tool *names* to call, in its
 *  own TypeScript code, chosen once by a person reading that tool's real documentation.
 *  Nothing here lets a model (or any dynamic logic) discover and call an arbitrary tool a
 *  remote server happens to expose — the read-only guarantee and the deterministic-
 *  disclosure boundary (CLAUDE.md rule 1) both depend on that staying true. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PRODUCT_SLUG } from '../brand.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withTimeout } from './outboundHttp.js';

const MCP_SESSION_TIMEOUT_MS = 45_000;

export interface RawCallToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Pure translation from a real `CallToolResult` to either a plain value or a thrown
 *  Error — split out from the actual `client.callTool()` invocation specifically so it's
 *  unit-testable without mocking the SDK's `Client` class, the same pure/impure split
 *  `openaiCompatible.ts`'s `buildChatCompletionsRequest` already uses for its own request-
 *  shape logic. Real MCP tool output is a `content` array (usually one
 *  `{type: 'text', text: '...'}` item carrying either plain text or a JSON string,
 *  depending on the tool) rather than a plain JSON body the way a REST response was, and
 *  `isError` is a normal, non-throwing field on an otherwise-successful call — this turns
 *  that into a real thrown Error, to match the throw-on-failure contract every existing
 *  connector in this codebase already expects from its own fetch()-based helpers. */
export function parseCallToolResult(result: RawCallToolResult, toolName: string): unknown {
  if (result.isError) {
    const text = result.content?.map((c) => c.text).filter(Boolean).join(' ') || 'tool call failed';
    throw new Error(`MCP tool "${toolName}" failed: ${text}`);
  }
  // Prefer structuredContent when a tool declares an output schema; otherwise fall back to
  // parsing the first text content block as JSON, and finally the raw text itself for a
  // tool that genuinely returns plain text rather than JSON.
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callMcpTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }) as RawCallToolResult;
  return parseCallToolResult(result, name);
}

/** Opens one real MCP session against `serverUrl` (a remote, hosted MCP endpoint — no
 *  self-hosting expected), authenticated with `bearerToken` the same way this codebase's
 *  connectors already send a stored PAT/API key as an `Authorization: Bearer` header, runs
 *  `fn` with a `callTool` bound to that session, and always closes the session afterward —
 *  success or failure. */
export async function withMcpSession<T>(
  serverUrl: string,
  bearerToken: string,
  fn: (callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: PRODUCT_SLUG, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  try {
    // Each HTTP request already has a deadline (outboundHttp.ts); this bounds the whole
    // session, since a server can keep a response stream open without finishing it.
    return await withTimeout(
      (async () => {
        await client.connect(transport);
        return fn((name, args) => callMcpTool(client, name, args));
      })(),
      MCP_SESSION_TIMEOUT_MS,
      `MCP session to ${new URL(serverUrl).host}`,
    );
  } finally {
    await transport.close().catch(() => {});
  }
}
