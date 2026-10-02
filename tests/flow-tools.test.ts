import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config.js';
import { createUnconfiguredContext } from '../src/context.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/** The local flow tools, driven through the MCP protocol exactly as Claude Code calls them. */
describe('init_flow scaffold', () => {
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-init-'));
    // Local tools need no backend — prove it by registering against an unconfigured context.
    ({ client, call } = await connectTools(createUnconfiguredContext(new ConfigurationError('not configured'))));
  });

  afterAll(async () => {
    await client.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('produces a flow that passes validate_flow and build_flow', async () => {
    const flowDir = join(scratchDir, 'fresh');
    const init = await call('init_flow', { flow_dir: flowDir });
    expect(init.isError).toBe(false);

    const validated = await call('validate_flow', { flow_dir: flowDir });
    expect(validated.isError, JSON.stringify(validated.body)).toBe(false);
    expect(validated.body.data.valid).toBe(true);

    const built = await call('build_flow', { flow_dir: flowDir });
    expect(built.isError, JSON.stringify(built.body)).toBe(false);
    expect(built.body.data.nodes.map((node: { type: string }) => node.type)).toEqual(
      expect.arrayContaining(['start', 'agent', 'end']),
    );
    expect(built.body.data.diagnostics.filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);
  });

  it('refuses to overwrite an existing flow source', async () => {
    const flowDir = join(scratchDir, 'twice');
    await call('init_flow', { flow_dir: flowDir });
    const second = await call('init_flow', { flow_dir: flowDir });
    expect(second.isError).toBe(true);
    expect(second.body.error).toMatch(/already exists/);
  });
});
