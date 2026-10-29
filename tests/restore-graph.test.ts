import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * restore_graph materializes a dump_graph snapshot as a new graph. EpicStaff removed conditional
 * edges, so a dump taken before that still lists them: they cannot be recreated and the restore
 * says so instead of dropping them silently. A classification table's sections have
 * client-generated primary keys, so the copy gets fresh section ids (the original's would clash).
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const metadata = (x: number) => ({ position: { x, y: 0 }, color: '#fff', icon: 'ti', size: { width: 320, height: 80 } });
const code = (id: number, body: string) => ({ id, code: body, entrypoint: 'main', secrets: [] });
const SECTION_ID = '0b7a9c1e-4c55-4d0e-9a54-3f1b2c3d4e5f';

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
    ],
    classification_decision_table_node_list: [
      {
        id: 15,
        graph: 7,
        node_name: 'Classifier',
        pre_python_code: null,
        pre_input_map: {},
        pre_output_variable_path: null,
        pre_use_storage: false,
        post_python_code: null,
        post_input_map: {},
        post_output_variable_path: null,
        post_use_storage: false,
        prompt_configs: [],
        default_llm_config: null,
        default_next_node_id: 14,
        next_error_node_id: null,
        condition_groups: [
          {
            id: 40,
            classification_decision_table_node: 15,
            group_name: 'gold',
            order: 1,
            expression: 'tier == "gold"',
            prompt: null,
            manipulation: null,
            continue_flag: false,
            route_code: 'Gold',
            dock_visible: true,
            field_expressions: {},
            field_manipulations: {},
            next_node_id: 14,
            section: SECTION_ID,
          },
        ],
        sections: [{ id: SECTION_ID, name: 'Tiers', metadata: { color: '#685FFF' } }],
        metadata: metadata(5),
      },
    ],
    end_node_list: [{ id: 14, graph: 7, output_map: { context: 'variables.context' }, metadata: metadata(4) }],
    edge_list: [
      { id: 20, graph: 7, start_node_id: 10, end_node_id: 11, metadata: {} },
      { id: 21, graph: 7, start_node_id: 11, end_node_id: 15, metadata: {} },
    ],
    // A dump taken while EpicStaff still had conditional edges.
    conditional_edge_list: [
      {
        id: 30,
        graph: 7,
        source_node_id: 11,
        python_code: code(130, 'def main(t):\n    return "Gold"'),
        input_map: { t: 'variables.tier' },
        metadata: {},
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

  beforeEach(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'es-mcp-restore-'));
    process.env.ES_MCP_STATE_DIR = scratchDir;
    received = [];
    nextId = 500;
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
      if (/^POST \/api\/graphs\/\d+\/save\/$/.test(key)) {
        // Echo the save: every created node gets a fresh id (listed in creation order).
        const graphId = Number(url.pathname.split('/')[3]);
        const echoed: Record<string, unknown> = { id: graphId, save_version: 2, edge_list: [] };
        for (const [listKey, items] of Object.entries(body as Record<string, unknown>)) {
          if (!listKey.endsWith('_list') || listKey === 'edge_list' || !Array.isArray(items)) continue;
          echoed[listKey] = items.map((item: Record<string, unknown>) => ({ ...item, id: item.id ?? (nextId += 1) }));
        }
        return reply(200, echoed);
      }
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

  it('reports the conditional edges of an old dump instead of recreating them', async () => {
    const { isError, body } = await restore({ name: 'routed-copy' });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(JSON.stringify(body.data.warnings)).toMatch(/1 conditional edge\(s\).*NOT restored.*decision-table/);
    expect(received.some((request) => request.path.includes('conditionaledges'))).toBe(false);
    expect(body.data).not.toHaveProperty('conditionalEdges');
  });

  it('gives the copy fresh CDT section ids and points its rows at them', async () => {
    const { isError, body } = await restore({ name: 'routed-copy' });
    expect(isError, JSON.stringify(body)).toBe(false);

    const save = received.find((request) => request.path === '/api/graphs/900/save/')!;
    const [table] = (save.body as {
      classification_decision_table_node_list: Array<{
        sections: Array<{ id: string; name: string }>;
        condition_groups: Array<{ section: string | null }>;
      }>;
    }).classification_decision_table_node_list;
    expect(table!.sections).toHaveLength(1);
    const freshId = table!.sections[0]!.id;
    expect(freshId).not.toBe(SECTION_ID);
    expect(freshId).toMatch(/^[0-9a-f-]{36}$/);
    expect(table!.sections[0]!.name).toBe('Tiers');
    expect(table!.condition_groups[0]!.section).toBe(freshId);
  });
});
