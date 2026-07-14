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
