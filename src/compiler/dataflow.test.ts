import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFlow } from './index.js';

/** Dataflow validation: variable reads vs producers/declarations (may-reach policy). */
describe('dataflow validation', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'es-mcp-dataflow-'));
  });
  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  async function compile(yaml: string) {
    writeFileSync(join(flowDir, 'flow.yaml'), yaml);
    const artifact = await compileFlow(flowDir);
    return {
      errors: artifact.diagnostics.filter((d) => d.severity === 'error'),
      warnings: artifact.diagnostics.filter((d) => d.severity === 'warning'),
    };
  }

  const AGENTS = `
llm_configs: { default: { model: gpt-4o } }
agents:
  a1: { instructions: hi, llm_config: default }
`;

  it('read produced by an upstream node → OK', async () => {
    const { errors, warnings } = await compile(`
meta: { name: upstream-ok }${AGENTS}
flow:
  nodes:
    start: { type: start }
    make:  { type: agent, agent: a1, tasks: [{ instructions: x }], output_variable_path: variables.reply }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { r: variables.reply } }
    finish: { type: end }
  edges:
    - { from: start, to: make }
    - { from: make, to: use }
    - { from: use, to: finish }
`);
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.path.includes('input_map'))).toEqual([]);
  });

  it('read produced on only one branch, read after the merge → OK (may-reach silent)', async () => {
    const { errors, warnings } = await compile(`
meta: { name: partial-branch }${AGENTS}
flow:
  nodes:
    start: { type: start }
    route:
      type: decision-table
      input_map: { p: variables.priority | low }
      rules: [{ condition: "p == 'high'", next_node: urgent }]
      default_next_node: normal
    urgent: { type: agent, agent: a1, tasks: [{ instructions: x }], output_variable_path: variables.escalation_id }
    normal: { type: agent, agent: a1, tasks: [{ instructions: y }], output_variable_path: variables.reply }
    send:   { type: agent, agent: a1, tasks: [{ instructions: z }], input_map: { e: variables.escalation_id } }
    finish: { type: end }
  edges:
    - { from: start, to: route }
    - { from: urgent, to: send }
    - { from: normal, to: send }
    - { from: send, to: finish }
`);
    // escalation_id is produced only on the urgent branch, but urgent reaches send → silent.
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.path.includes('input_map'))).toEqual([]);
  });

  it('read produced by NO node and not declared → ERROR', async () => {
    const { errors } = await compile(`
meta: { name: typo }${AGENTS}
flow:
  nodes:
    start: { type: start }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { r: variables.replyy } }
    finish: { type: end }
  edges:
    - { from: start, to: use }
    - { from: use, to: finish }
`);
    expect(errors.some((e) => /replyy/.test(e.message) && /no node produces/.test(e.message))).toBe(true);
  });

  it('read produced by a node that cannot reach the reader → WARNING', async () => {
    const { errors, warnings } = await compile(`
meta: { name: unreachable-producer }${AGENTS}
flow:
  nodes:
    start:   { type: start }
    reader:  { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { r: variables.late } }
    laterer: { type: agent, agent: a1, tasks: [{ instructions: z }], output_variable_path: variables.late }
    finish:  { type: end }
  edges:
    - { from: start, to: reader }
    - { from: reader, to: laterer }
    - { from: laterer, to: finish }
`);
    // 'late' is produced by laterer, which runs AFTER reader → warning, not error.
    expect(errors.filter((e) => e.path.includes('input_map'))).toEqual([]);
    expect(warnings.some((w) => /late/.test(w.message) && /reaches/.test(w.message))).toBe(true);
  });

  it('read declared in variables: (with default) → OK', async () => {
    const { errors, warnings } = await compile(`
meta: { name: declared }
variables:
  seed: { default: "hello" }${AGENTS}
flow:
  nodes:
    start: { type: start }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { s: variables.seed } }
    finish: { type: end }
  edges:
    - { from: start, to: use }
    - { from: use, to: finish }
`);
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.path.includes('input_map'))).toEqual([]);
  });

  it('read with a |default suffix → OK even if unproduced', async () => {
    const { errors } = await compile(`
meta: { name: pipe-default }${AGENTS}
flow:
  nodes:
    start: { type: start }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { r: "variables.maybe | fallback" } }
    finish: { type: end }
  edges:
    - { from: start, to: use }
    - { from: use, to: finish }
`);
    expect(errors.filter((e) => e.path.includes('input_map'))).toEqual([]);
  });

  it('bad root and malformed paths → ERROR', async () => {
    const badRoot = await compile(`
meta: { name: bad-root }${AGENTS}
flow:
  nodes:
    start: { type: start }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { r: state.foo } }
    finish: { type: end }
  edges: [{ from: start, to: use }, { from: use, to: finish }]
`);
    expect(badRoot.errors.some((e) => /must start with 'variables'/.test(e.message))).toBe(true);

    const malformed = await compile(`
meta: { name: malformed }${AGENTS}
flow:
  nodes:
    start: { type: start }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { r: "variables.a-b" } }
    finish: { type: end }
  edges: [{ from: start, to: use }, { from: use, to: finish }]
`);
    expect(malformed.errors.some((e) => /malformed variable path/.test(e.message))).toBe(true);
  });

  it('variables.shared[...] and __all__ are allowed', async () => {
    const { errors, warnings } = await compile(`
meta: { name: shared-all }${AGENTS}
flow:
  nodes:
    start: { type: start }
    use:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { s: "variables.shared[room].topic", a: "__all__" } }
    finish: { type: end }
  edges: [{ from: start, to: use }, { from: use, to: finish }]
`);
    expect(errors.filter((e) => e.path.includes('input_map'))).toEqual([]);
    expect(warnings.filter((w) => w.path.includes('input_map'))).toEqual([]);
  });

  it('nested prefix matching works both directions', async () => {
    const { errors } = await compile(`
meta: { name: nested }${AGENTS}
flow:
  nodes:
    start:  { type: start }
    make:   { type: agent, agent: a1, tasks: [{ instructions: x }], output_variable_path: variables.result }
    deep:   { type: agent, agent: a1, tasks: [{ instructions: y }], input_map: { s: variables.result.summary } }
    make2:  { type: agent, agent: a1, tasks: [{ instructions: z }], output_variable_path: variables.data.rows }
    parent: { type: agent, agent: a1, tasks: [{ instructions: w }], input_map: { d: variables.data } }
    finish: { type: end }
  edges:
    - { from: start, to: make }
    - { from: make, to: deep }
    - { from: deep, to: make2 }
    - { from: make2, to: parent }
    - { from: parent, to: finish }
`);
    // produce variables.result → read variables.result.summary OK;
    // produce variables.data.rows → read variables.data OK.
    expect(errors.filter((e) => e.path.includes('input_map'))).toEqual([]);
  });

  it('bad output_variable_path (write) → ERROR', async () => {
    const { errors } = await compile(`
meta: { name: bad-write }${AGENTS}
flow:
  nodes:
    start: { type: start }
    make:  { type: agent, agent: a1, tasks: [{ instructions: x }], output_variable_path: state.reply }
    finish: { type: end }
  edges: [{ from: start, to: make }, { from: make, to: finish }]
`);
    expect(errors.some((e) => e.path.endsWith('output_variable_path'))).toBe(true);
  });
});
