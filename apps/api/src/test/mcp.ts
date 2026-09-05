/**
 * What an in-process MCP server actually registered.
 *
 * The SDK's `createSdkMcpServer` hands back an `McpServer` whose tool table
 * is a private field. Reading it here — and only here, in test code — is
 * what lets a catalogue of names (`BOARD_TOOL_CATALOGUE`, `SYSTEM_TOOLS`…)
 * be held against the server built from the same module: a name that drifts
 * between the two is a tool the system workspace believes it pre-approved
 * and that opens an approval card regardless. If the SDK renames the field
 * this throws loudly rather than returning an empty list, so the assertion
 * cannot pass on nothing.
 */

import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

export function registeredToolNames(server: ReturnType<typeof createSdkMcpServer>): string[] {
  const table = (server.instance as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (!table || typeof table !== 'object') {
    throw new Error('McpServer no longer exposes _registeredTools — update test/mcp.ts');
  }
  return Object.keys(table);
}
