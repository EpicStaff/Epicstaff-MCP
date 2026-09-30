import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadFlowDirectory } from './loader.js';
import { findResolution, resolveFlow } from './resolver.js';
import { flowSourceSchema, type FlowSource } from './schema/index.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/flow-source',
);

async function loadFixture(name: string): Promise<FlowSource> {
  const { source, diagnostics } = await loadFlowDirectory(path.join(FIXTURES_DIR, name));
  if (source === null) {
    throw new Error(`fixture ${name} failed to load: ${JSON.stringify(diagnostics)}`);
  }
  return source;
}

/** Build a FlowSource from a plain object through the real schema. */
function makeSource(raw: unknown): FlowSource {
  return flowSourceSchema.parse(raw);
}

describe('resolveFlow', () => {
  it('resolves every reference in the valid fixture with zero diagnostics', async () => {
    const source = await loadFixture('valid-basic');
    const resolved = resolveFlow(source);

    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.flowName).toBe('research-and-write');
    expect(resolved.symbols.agents).toEqual(['researcher']);
    expect(resolved.symbols.surfaces).toEqual(['web_research']);

    expect(findResolution(resolved, 'agents.researcher.llm_config')).toEqual({
      kind: 'local',
      name: 'default',
    });
    expect(findResolution(resolved, 'agents.researcher.fcm_llm_config')).toEqual({
      kind: 'existing',
      remoteName: 'org-default-fcm',
    });
    expect(findResolution(resolved, 'agents.researcher.default_surfaces[0].surface')).toEqual({
      kind: 'local',
      name: 'web_research',
    });
    expect(findResolution(resolved, 'surfaces.web_research.python_tools[0].tool')).toEqual({
      kind: 'local',
      name: 'fetch_page',
    });
    expect(findResolution(resolved, 'surfaces.web_research.knowledge[0].collection')).toEqual({
      kind: 'local',
      name: 'docs',
    });
    expect(findResolution(resolved, 'flow.nodes.research.agent')).toEqual({
      kind: 'local',
      name: 'researcher',
    });
    expect(findResolution(resolved, 'flow.edges[0].from')).toEqual({
      kind: 'local',
      name: 'start',
    });
  });

  it('reports an unresolved reference with a precise path', async () => {
    const source = await loadFixture('invalid-unresolved-ref');
    const resolved = resolveFlow(source);

    expect(resolved.diagnostics).toHaveLength(1);
    const diagnostic = resolved.diagnostics[0]!;
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.path).toBe('agents.researcher.default_surfaces[0].surface');
    expect(diagnostic.message).toContain("unresolved reference 'missing_surface'");
    expect(diagnostic.message).toContain('{ existing: "missing_surface" }');
  });

  it('reports a type-mismatched reference (surface name used as an agent)', () => {
    const source = makeSource({
      meta: { name: 'mismatch' },
      surfaces: { helper_surface: {} },
      flow: {
        nodes: {
          start: { type: 'start' },
          work: { type: 'agent', agent: 'helper_surface' },
          finish: { type: 'end' },
        },
        edges: [
          { from: 'start', to: 'work' },
          { from: 'work', to: 'finish' },
        ],
      },
    });
    const resolved = resolveFlow(source);

    expect(resolved.diagnostics).toHaveLength(1);
    const diagnostic = resolved.diagnostics[0]!;
    expect(diagnostic.path).toBe('flow.nodes.work.agent');
    expect(diagnostic.message).toContain('type mismatch');
    expect(diagnostic.message).toContain("section 'surfaces'");
  });

  it('reports a circular subgraph reference to the flow itself', () => {
    const source = makeSource({
      meta: { name: 'loop-flow' },
      flow: {
        nodes: {
          start: { type: 'start' },
          inner: { type: 'subgraph', graph: 'loop-flow' },
          finish: { type: 'end' },
        },
        edges: [
          { from: 'start', to: 'inner' },
          { from: 'inner', to: 'finish' },
        ],
      },
    });
    const resolved = resolveFlow(source);

    expect(resolved.diagnostics).toHaveLength(1);
    const diagnostic = resolved.diagnostics[0]!;
    expect(diagnostic.path).toBe('flow.nodes.inner.graph');
    expect(diagnostic.message).toContain('circular subgraph reference');
  });

  it('resolves subgraph references to remote and sibling flows', () => {
    const source = makeSource({
      meta: { name: 'outer' },
      flow: {
        nodes: {
          start: { type: 'start' },
          remote: { type: 'subgraph', graph: { existing: 'remote-flow' } },
          sibling: { type: 'subgraph', graph: 'other-local-flow' },
          finish: { type: 'end' },
        },
        edges: [
          { from: 'start', to: 'remote' },
          { from: 'remote', to: 'sibling' },
          { from: 'sibling', to: 'finish' },
        ],
      },
    });
    const resolved = resolveFlow(source);

    expect(resolved.diagnostics).toEqual([]);
    expect(findResolution(resolved, 'flow.nodes.remote.graph')).toEqual({
      kind: 'existing',
      remoteName: 'remote-flow',
    });
    expect(findResolution(resolved, 'flow.nodes.sibling.graph')).toEqual({
      kind: 'local',
      name: 'other-local-flow',
    });
  });

  it('reports edges pointing at unknown nodes', () => {
    const source = makeSource({
      meta: { name: 'bad-edges' },
      flow: {
        nodes: {
          start: { type: 'start' },
          finish: { type: 'end' },
        },
        edges: [{ from: 'start', to: 'nope' }],
      },
    });
    const resolved = resolveFlow(source);

    expect(resolved.diagnostics).toHaveLength(1);
    const diagnostic = resolved.diagnostics[0]!;
    expect(diagnostic.path).toBe('flow.edges[0].to');
    expect(diagnostic.message).toContain("unknown node 'nope'");
  });

  it('resolves decision-table next_node references against nodes', () => {
    const source = makeSource({
      meta: { name: 'routing' },
      flow: {
        nodes: {
          start: { type: 'start' },
          route: {
            type: 'decision-table',
            rules: [{ condition: "state['x'] > 1", next_node: 'finish' }],
            default_next_node: 'missing_target',
          },
          finish: { type: 'end' },
        },
        edges: [{ from: 'start', to: 'route' }],
      },
    });
    const resolved = resolveFlow(source);

    expect(findResolution(resolved, 'flow.nodes.route.rules[0].next_node')).toEqual({
      kind: 'local',
      name: 'finish',
    });
    expect(resolved.diagnostics).toHaveLength(1);
    expect(resolved.diagnostics[0]!.path).toBe('flow.nodes.route.default_next_node');
  });
});
