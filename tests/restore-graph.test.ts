import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * restore_graph used to drop conditional edges with a "recreate them by hand" warning, so a
 * restored copy did not route like the original. They are now recreated through
 * conditionaledges/ (the endpoint push_flow uses), addressed by the copy's new node ids.
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const metadata = (x: number) => ({ position: { x, y: 0 }, color: '#fff', icon: 'ti', size: { width: 320, height: 80 } });
const code = (id: number, body: string) => ({ id, code: body, entrypoint: 'main', libraries: [], secrets: [] });

function dumpedGraph(): Record<string, unknown> {
  return {
    id: 7,
    name: 'routed',
    description: '',
    save_version: 4,
    metadata: { nodes: [], connections: [] },
    start_node_list: [{ id: 10, graph: 7, variables: { variables: { tier: null } }, metadata: metadata(0) }],
    python_node_list: [
      { id: 11, node_name: 'Verdict', graph: 7, python_code: code(101, 'def main():\n    return 1'), input_map: {}, test_input: {}, output_variable_path: null, metadata: metadata(1) },
      { id: 12, node_name: 'Gold', graph: 7, python_code: code(102, "def main():\n    return 'gold'"), input_map: {}, test_input: {}, output_variable_path: 'variables.path', metadata: metadata(2) },
      { id: 13, node_name: 'Basic', graph: 7, python_code: code(103, "def main():\n    return 'basic'"), input_map: {}, test_input: {}, output_variable_path: 'variables.path', metadata: metadata(3) },
    ],
    end_node_list: [{ id: 14, graph: 7, output_map: { context: 'variables.context' }, metadata: metadata(4) }],
    edge_list: [
      { id: 20, graph: 7, start_node_id: 10, end_node_id: 11, metadata: {} },
      { id: 21, graph: 7, start_node_id: 12, end_node_id: 14, metadata: {} },
      { id: 22, graph: 7, start_node_id: 13, end_node_id: 14, metadata: {} },
    ],
    conditional_edge_list: [
      {
        id: 30,
        graph: 7,
        source_node_id: 11,
        python_code: { ...code(130, 'def main(t):\n    return "Gold" if t == "gold" else "Basic"'), global_kwargs: { k: 1 }, secrets: [{ id: 5, name: 'S' }] },
        input_map: { t: 'variables.tier' },
        metadata: { label: 'route' },
      },
    ],
  };
}

describe('restore_graph', () => {
  let scratchDir: string;
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  let received: Array<{ method: string; path: string; body: unknown }>;
  let nextId: number;
  let targetGraph: Record<string, unknown> | null;

  beforeEach(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-restore-'));
    process.env.ES_MCP_STATE_DIR = scratchDir;
    received = [];
    nextId = 500;
    targetGraph = null;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      received.push({ method, path: url.pathname, body });
      const reply = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
      const key = `${method} ${url.pathname}`;
      if (key === 'GET /api/auth/api-key/validate/') return reply(200, { active: true });
      if (key === 'GET /api/profile/') return reply(200, { memberships: [{ organization: { id: 1, name: 'Org', is_active: true } }] });
      if (key === 'POST /api/graphs/') return reply(201, { id: 900, name: body.name, save_version: 1 });
      if (key === 'GET /api/graphs/901/' && targetGraph) return reply(200, targetGraph);
      if (/^POST \/api\/graphs\/\d+\/save\/$/.test(key)) {
        // Echo the save: every created node gets a fresh id (listed in creation order).
        const graphId = Number(url.pathname.split('/')[3]);
        const echoed: Record<string, unknown> = { id: graphId, save_version: 2, edge_list: [], conditional_edge_list: [] };
        for (const [listKey, items] of Object.entries(body as Record<string, unknown>)) {
          if (!listKey.endsWith('_list') || listKey === 'edge_list' || !Array.isArray(items)) continue;
          echoed[listKey] = items.map((item: Record<string, unknown>) => ({ ...item, id: item.id ?? (nextId += 1) }));
        }
        return reply(200, echoed);
      }
      if (key === 'POST /api/conditionaledges/') return reply(201, { ...body, id: (nextId += 1) });
      if (/^DELETE \/api\/conditionaledges\/\d+\/$/.test(key)) return new Response(null, { status: 204 });
      return reply(404, { detail: `no mock for ${key}` });
    });

    const context = createContext(loadConfig(ENV));
    context.store.update({ apiKey: 'stored-key', keyPrefix: 'stored-k', activeOrgId: 1 });
    ({ client, call } = await connectTools(context));
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    rmSync(scratchDir, { recursive: true, force: true });
  });

  async function restore(args: Record<string, unknown>) {
    const dumpPath = join(scratchDir, 'dump.json');
    writeFileSync(dumpPath, JSON.stringify(dumpedGraph()));
    return call('restore_graph', { dump_path: dumpPath, ...args });
  }

  it('recreates conditional edges on the new graph, addressed by the new source node id', async () => {
    const { isError, body } = await restore({ name: 'routed-copy' });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(body.data.conditionalEdges).toBe(1);
    expect(JSON.stringify(body.data.warnings)).not.toMatch(/conditional edge/i);

    const posted = received.filter((call) => call.method === 'POST' && call.path === '/api/conditionaledges/');
    expect(posted).toHaveLength(1);
    const edge = posted[0]!.body as Record<string, unknown>;
    expect(edge).toMatchObject({
      graph: 900,
      input_map: { t: 'variables.tier' },
      metadata: { label: 'route' },
      python_code: {
        code: 'def main(t):\n    return "Gold" if t == "gold" else "Basic"',
        entrypoint: 'main',
        libraries: [],
        global_kwargs: { k: 1 },
        secret_ids: [5],
      },
    });
    // A fresh python_code row — never the original's id.
    expect(edge.python_code).not.toHaveProperty('id');
    // The source is the copy of "Verdict" (not the dumped id 11).
    expect(edge.source_node_id).not.toBe(11);
    const save = received.find((call) => call.path === '/api/graphs/900/save/')!;
    const pythonSent = (save.body as { python_node_list: Array<{ node_name: string }> }).python_node_list;
    expect(pythonSent.map((node) => node.node_name)).toContain('Verdict');
    // Echo ids: start node first (501), then python nodes in order.
    const verdictIndex = pythonSent.findIndex((node) => node.node_name === 'Verdict');
    expect(edge.source_node_id).toBe(502 + verdictIndex);
  });

  it('overwrite mode drops the target conditional edges before recreating the dump ones', async () => {
    targetGraph = { ...dumpedGraph(), id: 901, name: 'target', save_version: 9, conditional_edge_list: [{ ...(dumpedGraph().conditional_edge_list as Array<Record<string, unknown>>)[0]!, id: 77 }] };
    const { isError, body } = await restore({ target_graph_id: 901 });
    expect(isError, JSON.stringify(body)).toBe(false);
    const deleteIndex = received.findIndex((call) => call.method === 'DELETE' && call.path === '/api/conditionaledges/77/');
    const createIndex = received.findIndex((call) => call.method === 'POST' && call.path === '/api/conditionaledges/');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(deleteIndex);
    expect(body.data.conditionalEdges).toBe(1);
  });
});
