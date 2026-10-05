import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/** generate_chat_ui must not write the MCP user's long-lived API key into the HTML unless asked. */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const STORED_KEY = 'es-stored-long-lived-key-0123456789';

describe('generate_chat_ui', () => {
  let scratchDir: string;
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;

  beforeEach(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-chatui-'));
    process.env.ES_MCP_STATE_DIR = scratchDir;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      const reply = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
      if (path === '/api/auth/api-key/validate/') return reply({ active: true });
      if (path === '/api/profile/') return reply({ memberships: [{ organization: { id: 3, name: 'Org', is_active: true } }] });
      if (path === '/api/graph-light/') return reply([{ id: 12, name: 'Chat bot', description: '' }]);
      return new Response('{}', { status: 404 });
    });
    const context = createContext(loadConfig(ENV));
    context.store.update({ apiKey: STORED_KEY, keyPrefix: 'es-store', activeOrgId: 3 });
    ({ client, call } = await connectTools(context));
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('does not embed the API key by default', async () => {
    const outputPath = join(scratchDir, 'chat.html');
    const { isError, body } = await call('generate_chat_ui', { graph_id: 12, output_path: outputPath });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.embedded_api_key).toBe(false);
    expect(body.data).not.toHaveProperty('warning');
    expect(readFileSync(outputPath, 'utf8')).not.toContain(STORED_KEY);
  });

  it('embeds the key only when asked, and says so loudly', async () => {
    const outputPath = join(scratchDir, 'chat-key.html');
    const { body } = await call('generate_chat_ui', { graph_id: 12, output_path: outputPath, embed_api_key: true });
    expect(body.data.embedded_api_key).toBe(true);
    expect(body.data.warning).toMatch(/CONTAINS the long-lived EpicStaff API key/);
    expect(readFileSync(outputPath, 'utf8')).toContain(STORED_KEY);
  });
});
