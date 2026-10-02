import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, loadConfig } from '../src/config.js';
import { createUnconfiguredContext } from '../src/context.js';
import { connectTools } from './helpers/mcp-harness.js';

/**
 * Issue: an invalid environment used to kill the process at startup, so Claude Code only showed
 * "Connection closed". Now the server starts, registers every tool, and each backend tool returns
 * the actionable configuration error. Local tools keep working.
 */
const LOCAL_TOOLS = new Set(['init_flow', 'validate_flow', 'build_flow', 'describe_node_types']);

type JsonSchema = { type?: string; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; anyOf?: JsonSchema[] };

function sampleValue(schema: JsonSchema, scratchDir: string, key: string): unknown {
  if (schema.enum?.length) return schema.enum[0];
  const type = schema.type ?? schema.anyOf?.[0]?.type;
  switch (type) {
    case 'string':
      return /path|dir/.test(key) ? join(scratchDir, key) : 'sample';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return false;
    case 'array':
      return [sampleValue(schema.items ?? {}, scratchDir, key)];
    default:
      return {};
  }
}

describe('server started without a valid environment', () => {
  let client: Client;
  let scratchDir: string;
  let configError: ConfigurationError;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-unconfigured-'));
    try {
      loadConfig({ EPICSTAFF_BASE_URL: '${EPICSTAFF_BASE_URL}' });
      throw new Error('expected loadConfig to fail');
    } catch (error) {
      configError = error as ConfigurationError;
    }
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    ({ client } = await connectTools(createUnconfiguredContext(configError)));
  });

  afterAll(async () => {
    await client.close();
    vi.unstubAllGlobals();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('is a ConfigurationError naming the missing settings', () => {
    expect(configError).toBeInstanceOf(ConfigurationError);
    expect(configError.message).toMatch(/EPICSTAFF_BASE_URL is not set/);
  });

  it('check_connection returns the configuration error with a fix-it hint', async () => {
    const result = await client.callTool({ name: 'check_connection', arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(result.isError).toBe(true);
    expect(body.error).toMatch(/Invalid EpicStaff MCP configuration/);
    expect(body.hint).toMatch(/EPICSTAFF_BASE_URL/);
  });

  it('registers all 44 tools and every backend tool reports the configuration error', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(44);
    for (const tool of tools) {
      if (LOCAL_TOOLS.has(tool.name)) continue;
      const schema = tool.inputSchema as JsonSchema;
      const args: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        args[key] = sampleValue(schema.properties?.[key] ?? {}, scratchDir, key);
      }
      const result = await client.callTool({ name: tool.name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(result.isError, `${tool.name}: ${text}`).toBe(true);
      expect(text, tool.name).toMatch(/Invalid EpicStaff MCP configuration/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('local tools still work (describe_node_types)', async () => {
    const result = await client.callTool({ name: 'describe_node_types', arguments: {} });
    expect(result.isError).toBeFalsy();
  });
});
