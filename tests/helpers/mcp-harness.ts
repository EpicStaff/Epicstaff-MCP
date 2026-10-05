import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../src/context.js';
import { registerAllTools } from '../../src/tools/registry.js';

export interface ToolCallResult {
  isError: boolean;
  // Parsed ToolResult envelope ({ ok, data } | { ok: false, error, hint, … }).
  body: { ok: boolean; data?: any; error?: string; hint?: string; [key: string]: unknown };
  text: string;
}

/** Register every tool against `context` and connect an MCP client over an in-memory transport. */
export async function connectTools(context: AppContext): Promise<{
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
}> {
  const server = new McpServer({ name: 'epicstaff', version: 'test' });
  registerAllTools(server, context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    let body: ToolCallResult['body'];
    try {
      body = JSON.parse(text) as ToolCallResult['body'];
    } catch {
      body = { ok: false, error: text };
    }
    return { isError: result.isError === true, body, text };
  };
  return { client, call };
}
