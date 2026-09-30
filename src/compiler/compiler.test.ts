import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFlow } from './index.js';

/** Semantic validation + emit behavior of the compiler pipeline. */
describe('compileFlow semantic validation', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'es-mcp-compiler-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  function writeFlow(yaml: string): void {
    writeFileSync(join(flowDir, 'flow.yaml'), yaml);
  }

  it('rejects a RAG search-config type that mismatches the collection strategy', async () => {
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
    writeFlow(`
meta: { name: rag-mismatch }
knowledge:
  docs:
    documents: [docs/a.md]
    rag: { strategy: naive }
surfaces:
  s1:
    knowledge:
      - collection: docs
        graph_basic_search_config: { k: 5, max_context_tokens: 4000 }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default, default_surfaces: [{ surface: s1, place: all }] }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /graph|naive|rag|strategy/i.test(diagnostic.message))).toBe(true);
  });

  it('emits a named RAG embedder as a plain embedders.<name> ref (no existing: prefix)', async () => {
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
    writeFlow(`
meta: { name: named-embedder }
knowledge:
  docs:
    documents: [docs/a.md]
    rag: { strategy: naive, embedder: marketing-embeddings }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors).toEqual([]);
    const collection = artifact.entities.find((plan) => plan.kind === 'knowledge_collection');
    expect(collection?.rag?.embedder).toEqual({ $ref: 'embedders.marketing-embeddings' });
  });

  it('maps graph RAG embedder + index-config fields into the plan', async () => {
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
    writeFlow(`
meta: { name: graph-index-config }
knowledge:
  kb:
    documents: [docs/a.md]
    rag:
      strategy: graph
      llm_config: default
      embedder: my-embedder
      chunk_size: 900
      chunk_overlap: 80
      entity_types: [service, feature, person]
      max_gleanings: 2
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const collection = artifact.entities.find((plan) => plan.kind === 'knowledge_collection');
    expect(collection?.rag?.embedder).toEqual({ $ref: 'embedders.my-embedder' });
    expect(collection?.rag?.index_config).toEqual({
      chunk_size: 900,
      chunk_overlap: 80,
      entity_types: ['service', 'feature', 'person'],
      max_gleanings: 2,
    });
  });

  it('omitted RAG tuning fields stay out of the plan (rag content-hash stability)', async () => {
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
    writeFlow(`
meta: { name: rag-defaults }
knowledge:
  plain_naive:
    documents: [docs/a.md]
    rag: { strategy: naive }
  plain_graph:
    documents: [docs/a.md]
    rag: { strategy: graph, llm_config: default }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const collections = artifact.entities.filter((plan) => plan.kind === 'knowledge_collection');
    const naive = collections.find((plan) => plan.name === 'plain_naive');
    const graph = collections.find((plan) => plan.name === 'plain_graph');
    // Exact shape matters: an extra key (even undefined-valued) would change the
    // rag content hash and force a spurious re-index of every existing flow.
    expect(naive?.rag).toEqual({ strategy: 'naive', embedder: { $ref: 'embedders.default' } });
    expect(graph?.rag).toEqual({
      strategy: 'graph',
      embedder: { $ref: 'embedders.default' },
      llm: { $ref: 'llm_configs.default' },
    });
  });

  it('rejects search-time settings on the rag config (they live on surface knowledge entries)', async () => {
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
    writeFlow(`
meta: { name: rag-search-time-keys }
knowledge:
  kb:
    documents: [docs/a.md]
    rag: { strategy: graph, llm_config: default, community_level: 2, search_limit: 5 }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /community_level|search_limit|unrecognized/i.test(diagnostic.message))).toBe(true);
  });

  it('rejects chunk_overlap >= chunk_size on a rag config', async () => {
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
    writeFlow(`
meta: { name: rag-overlap-too-big }
knowledge:
  kb:
    documents: [docs/a.md]
    rag: { strategy: naive, chunk_size: 200, chunk_overlap: 200 }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /chunk_overlap.*smaller than chunk_size/i.test(diagnostic.message))).toBe(true);
  });

  it('rejects an edge out of an end node', async () => {
    writeFlow(`
meta: { name: edge-from-end }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: finish, to: work }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /end/i.test(diagnostic.message))).toBe(true);
  });

  it('warns on a defined-but-unused entity', async () => {
    writeFlow(`
meta: { name: unused-entity }
llm_configs:
  never_used: { model: gpt-3.5-turbo }
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(
      artifact.diagnostics.some(
        (diagnostic) => diagnostic.severity === 'warning' && /never referenced|unused/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it('routes a condition edge into summary.conditionalEdges, not graph edges', async () => {
    writeFlow(`
meta: { name: conditional }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - from: work
      condition:
        code: |
          def main(state):
              return "finish"
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const conditionalEdges = artifact.summary.conditionalEdges as Array<{ sourceNodeName: string }>;
    expect(conditionalEdges.length).toBe(1);
    expect(conditionalEdges[0]!.sourceNodeName).toBe('work');
    // The plain edges: start→work and work→finish only.
    expect(artifact.graph.edges.length).toBe(2);
  });

  it('lays out every node on the grid with type-specific colors/icons', async () => {
    writeFlow(`
meta: { name: layout-check }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    for (const node of artifact.graph.nodes) {
      expect(node.position.x % 20).toBe(0);
      expect(node.color).toBeTruthy();
      expect(node.icon).toBeTruthy();
      expect(node.size.width).toBeGreaterThan(0);
    }
    // Left-to-right layering: start < work < finish.
    const xs = artifact.graph.nodes.map((node) => node.position.x);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
  });

  it('rejects more than one end node (unique_graph_end_node)', async () => {
    writeFlow(`
meta: { name: two-ends }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish_a: { type: end }
    finish_b: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish_a }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /at most one end node/i.test(diagnostic.message))).toBe(true);
  });

  /** Read the emitted start node's raw `initialState` (the wrapped envelope). */
  function startEnvelope(artifact: Awaited<ReturnType<typeof compileFlow>>): Record<string, unknown> {
    const start = artifact.graph.nodes.find((node) => node.type === 'start');
    return (start as { data: { initialState: Record<string, unknown> } }).data.initialState;
  }

  /** Read the actual domain values (the inner `variables` of the wrapped envelope). */
  function startDomain(artifact: Awaited<ReturnType<typeof compileFlow>>): Record<string, unknown> {
    return startEnvelope(artifact).variables as Record<string, unknown>;
  }

  it('emits the native wrapped scheme: {variables, persistent_variables:{user,organization}}', async () => {
    writeFlow(`
meta: { name: wrapped-scheme }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const envelope = startEnvelope(artifact);
    expect(Object.keys(envelope).sort()).toEqual(['persistent_variables', 'variables']);
    expect(envelope.persistent_variables).toEqual({ user: [], organization: [] });
    expect((envelope.variables as Record<string, unknown>).context).toBeNull();
  });

  it('records persist-marked declarations in the persistent_variables buckets', async () => {
    writeFlow(`
meta: { name: persist-vars }
variables:
  pref: { default: {}, persist: user }
  org_cfg: { default: {}, persist: organization }
  scratch: { default: 0 }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const envelope = startEnvelope(artifact);
    expect(envelope.persistent_variables).toEqual({ user: ['pref'], organization: ['org_cfg'] });
    // The domain still carries all declared vars (persist is orthogonal to presence).
    expect(Object.keys(startDomain(artifact))).toEqual(
      expect.arrayContaining(['context', 'pref', 'org_cfg', 'scratch']),
    );
  });

  it('always seeds the conventional `context` variable into every start-node domain', async () => {
    // No variables declared, no producers — the domain must still carry `context`.
    writeFlow(`
meta: { name: context-convention }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const domain = startDomain(artifact);
    expect(Object.keys(domain)).toContain('context');
    expect(domain.context).toBeNull();
  });

  it('lets a declaration override the conventional `context` seed', async () => {
    writeFlow(`
meta: { name: context-override }
variables:
  context: { default: { seeded: true } }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work: { type: agent, agent: a1, tasks: [{ instructions: do the work }] }
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(startDomain(artifact).context).toEqual({ seeded: true });
  });

  it('forces a produced-only variable into the start-node domain even when undeclared', async () => {
    // `result` is only ever produced via output_variable_path and never declared under
    // `variables:`. It must still land in the start node domain (backend treats
    // start_node.variables as the flow's variable domain), seeded null.
    writeFlow(`
meta: { name: produced-only-var }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    work:
      type: agent
      agent: a1
      tasks: [{ instructions: do the work }]
      output_variable_path: variables.result
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const domain = startDomain(artifact);
    expect(Object.keys(domain)).toContain('result');
    expect(domain.result).toBeNull();
  });

  it('lets a declared default and inline initial_state win over the produced placeholder', async () => {
    // `quote` is both declared (with a default) and produced; `topic` comes from inline
    // start.initial_state. Neither should be clobbered by the produced-null placeholder.
    writeFlow(`
meta: { name: domain-precedence }
variables:
  quote: { default: {}, description: "pricing result" }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start:
      type: start
      initial_state: { topic: "pallets" }
    work:
      type: agent
      agent: a1
      tasks: [{ instructions: do the work }]
      output_variable_path: variables.quote
    finish: { type: end }
  edges:
    - { from: start, to: work }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const domain = startDomain(artifact);
    expect(domain.quote).toEqual({}); // declared default wins over produced null
    expect(domain.topic).toBe('pallets'); // inline initial_state preserved
  });

  it('rejects parallel fan-out (a node with two outgoing plain edges)', async () => {
    writeFlow(`
meta: { name: fan-out }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    split: { type: agent, agent: a1, tasks: [{ instructions: split }] }
    left: { type: agent, agent: a1, tasks: [{ instructions: left }] }
    right: { type: agent, agent: a1, tasks: [{ instructions: right }] }
    finish: { type: end }
  edges:
    - { from: start, to: split }
    - { from: split, to: left }
    - { from: split, to: right }
    - { from: left, to: finish }
    - { from: right, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /parallel fan-out|outgoing edges/i.test(diagnostic.message))).toBe(true);
  });

  it('rejects fan-out directly from the start node', async () => {
    writeFlow(`
meta: { name: start-fan-out }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    a: { type: agent, agent: a1, tasks: [{ instructions: a }] }
    b: { type: agent, agent: a1, tasks: [{ instructions: b }] }
    finish: { type: end }
  edges:
    - { from: start, to: a }
    - { from: start, to: b }
    - { from: a, to: finish }
    - { from: b, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    const errors = artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    expect(errors.some((diagnostic) => /start node keeps only its first edge|parallel fan-out/i.test(diagnostic.message))).toBe(true);
  });

  it('classification-decision-table categories emit a route_code so the route resolves', async () => {
    writeFlow(`
meta: { name: cdt-routes }
llm_configs:
  default: { model: gpt-4o }
agents:
  a1: { instructions: hi, llm_config: default }
flow:
  nodes:
    start: { type: start }
    classify:
      type: classification-decision-table
      llm_config: default
      categories:
        - { name: yes, next_node: work }
      default_next_node: finish
    work: { type: agent, agent: a1, tasks: [{ instructions: do it }] }
    finish: { type: end }
  edges:
    - { from: start, to: classify }
    - { from: work, to: finish }
`);
    const artifact = await compileFlow(flowDir);
    expect(artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const cdt = artifact.graph.nodes.find((node) => node.type === 'classification-decision-table');
    const group = (cdt as { data: { table: { condition_groups: Array<{ route_code?: string; next_node?: string }> } } })
      .data.table.condition_groups[0]!;
    // route_code must be set (the bulk-save mapper only resolves next_node when it is)
    // and next_node must point at the target node's uuid.
    expect(group.route_code).toBeTruthy();
    expect(group.next_node).toBeTruthy();
  });
});
