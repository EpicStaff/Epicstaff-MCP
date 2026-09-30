import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyValueGraphNode, KnowledgeRetrieverGraphNode, TelegramTriggerGraphNode } from '../graph/graph-state.js';
import { compileFlow } from './index.js';
import { validateKeyValueEntries } from './key-value-entries.js';

/** knowledge-retriever / key-value nodes and secret-backed credentials, end to end through the compiler. */
describe('compileFlow: knowledge-retriever, key-value, secrets', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'es-mcp-new-nodes-'));
    mkdirSync(join(flowDir, 'docs'), { recursive: true });
    writeFileSync(join(flowDir, 'docs/a.md'), 'content');
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  function writeFlow(nodesYaml: string, edgesYaml: string, extraSections = ''): void {
    writeFileSync(
      join(flowDir, 'flow.yaml'),
      `
meta: { name: new-nodes }
knowledge:
  docs:
    documents: [docs/a.md]
    rag: { strategy: naive }
${extraSections}
flow:
  nodes:
    start: { type: start, initial_state: { question: q, user_id: u1 } }
${nodesYaml}
    finish: { type: end }
  edges:
${edgesYaml}
`,
    );
  }

  const errorsOf = (diagnostics: Array<{ severity: string; path: string; message: string }>) =>
    diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

  it('emits a knowledge-retriever with a collection ref and a collection-RAG ref of the local strategy', async () => {
    writeFlow(
      `    retrieve:
      type: knowledge-retriever
      collection: docs
      query: "{question}"
      input_map: { question: variables.question }
      output_variable_path: variables.docs`,
      `    - { from: start, to: retrieve }
    - { from: retrieve, to: finish }`,
    );
    const artifact = await compileFlow(flowDir);
    expect(errorsOf(artifact.diagnostics)).toEqual([]);

    const node = artifact.graph.nodes.find((candidate) => candidate.type === 'knowledge-retriever') as
      | KnowledgeRetrieverGraphNode
      | undefined;
    expect(node?.data).toStrictEqual({
      source_collection: { $ref: 'knowledge.docs' },
      rag_type: 'naive',
      rag_id: { $ref: 'knowledge.docs#rag:naive' },
      query: '{question}',
      search_method: null,
      search_configs: null,
    });
    expect(node?.output_variable_path).toBe('variables.docs');
    // The collection counts as used — no unused-entity warning.
    expect(artifact.diagnostics.some((diagnostic) => diagnostic.path === 'knowledge.docs')).toBe(false);
  });

  it('stores the backend default search_method "basic" when graph search configs are given', async () => {
    writeFlow(
      `    retrieve:
      type: knowledge-retriever
      collection: { existing: "Graph Docs" }
      rag: graph
      query: "{question}"
      search_configs: { graph: { basic: { k: 5 } } }
      input_map: { question: variables.question }
      output_variable_path: variables.docs`,
      `    - { from: start, to: retrieve }
    - { from: retrieve, to: finish }`,
    );
    const artifact = await compileFlow(flowDir);
    expect(errorsOf(artifact.diagnostics)).toEqual([]);
    const node = artifact.graph.nodes.find((candidate) => candidate.type === 'knowledge-retriever') as
      | KnowledgeRetrieverGraphNode
      | undefined;
    // Matches what GET graphs/{id}/ reads back (search_method is write-only), so a repush diffs clean.
    expect(node?.data.search_method).toBe('basic');
    expect(node?.data.search_configs).toStrictEqual({ graph: { basic: { k: 5 }, search_method: 'basic' } });
  });

  it('requires rag: for an existing collection and rejects a rag type that contradicts a local collection', async () => {
    writeFlow(
      `    remote:
      type: knowledge-retriever
      collection: { existing: "Handbook" }
      query: "{question}"
      input_map: { question: variables.question }
      output_variable_path: variables.a
    local:
      type: knowledge-retriever
      collection: docs
      rag: graph
      query: "{question}"
      input_map: { question: variables.question }
      output_variable_path: variables.b`,
      `    - { from: start, to: remote }
    - { from: remote, to: local }
    - { from: local, to: finish }`,
    );
    const errors = errorsOf((await compileFlow(flowDir)).diagnostics);
    expect(errors.map((error) => error.path).sort()).toStrictEqual(['flow.nodes.local.rag', 'flow.nodes.remote.rag']);
  });

  it('warns about a query placeholder with no input_map entry', async () => {
    writeFlow(
      `    retrieve:
      type: knowledge-retriever
      collection: docs
      query: "{question} {missing}"
      input_map: { question: variables.question }
      output_variable_path: variables.docs`,
      `    - { from: start, to: retrieve }
    - { from: retrieve, to: finish }`,
    );
    const artifact = await compileFlow(flowDir);
    expect(errorsOf(artifact.diagnostics)).toEqual([]);
    expect(
      artifact.diagnostics.some(
        (diagnostic) => diagnostic.severity === 'warning' && diagnostic.message.includes('{missing}'),
      ),
    ).toBe(true);
  });

  it('emits a key-value node with an ensure plan for its table; read targets feed the dataflow', async () => {
    writeFlow(
      `    lookup:
      type: key-value
      table: User Profiles
      mode: read
      entries:
        - { key: "profile_{variables.user_id}", value: " variables.profile " }
    use:
      type: python
      code: "def main(p): return p"
      input_map: { p: variables.profile }
      output_variable_path: variables.used`,
      `    - { from: start, to: lookup }
    - { from: lookup, to: use }
    - { from: use, to: finish }`,
    );
    const artifact = await compileFlow(flowDir);
    // variables.profile is produced by the key-value read — no "no node produces" error.
    expect(errorsOf(artifact.diagnostics)).toEqual([]);

    const node = artifact.graph.nodes.find((candidate) => candidate.type === 'key-value') as
      | KeyValueGraphNode
      | undefined;
    expect(node?.output_variable_path).toBeNull();
    expect(node?.input_map).toStrictEqual({});
    expect(node?.data).toStrictEqual({
      key_value_table: { $ref: 'key_value_tables.User Profiles' },
      mode: 'read',
      // Mirrors the backend, which stores the stripped path.
      entries: [{ key: 'profile_{variables.user_id}', value: 'variables.profile' }],
    });
    const tablePlan = artifact.entities.find((plan) => plan.kind === 'key_value_table');
    expect(tablePlan).toMatchObject({
      key: 'key_value_tables.User Profiles',
      action: 'ensure',
      remoteName: 'User Profiles',
      payload: { name: 'User Profiles' },
    });
    // The produced variable joins the start-node domain.
    const start = artifact.graph.nodes.find((candidate) => candidate.type === 'start');
    const domain = (start?.data as { initialState: { variables: Record<string, unknown> } }).initialState.variables;
    expect(domain).toHaveProperty('profile');
  });

  it('reports backend entry rules (mode fields, key template, read |default) per entry', async () => {
    writeFlow(
      `    bad:
      type: key-value
      table: t
      mode: read
      entries:
        - { key: "ok_key", value: "variables.a|0" }
        - { key: "9starts_with_digit", value: variables.b }
        - { key: "k" }`,
      `    - { from: start, to: bad }
    - { from: bad, to: finish }`,
    );
    const errors = errorsOf((await compileFlow(flowDir)).diagnostics);
    expect(errors.map((error) => error.path)).toStrictEqual([
      'flow.nodes.bad.entries[0]',
      'flow.nodes.bad.entries[1]',
      'flow.nodes.bad.entries[2]',
    ]);
  });

  it('rejects the pull_flow table placeholder instead of creating a table by that name', async () => {
    writeFlow(
      `    kv:
      type: key-value
      table: UNRESOLVED
      mode: delete
      entries: [{ key: k }]`,
      `    - { from: start, to: kv }
    - { from: kv, to: finish }`,
    );
    const errors = errorsOf((await compileFlow(flowDir)).diagnostics);
    expect(errors.map((error) => error.path)).toStrictEqual(['flow.nodes.kv.table']);
  });

  it('turns api_key_env and bot_token_env into secret ensure plans — never a raw value', async () => {
    writeFlow(
      `    bot:
      type: telegram-trigger
      bot_token_env: ES_TEST_BOT_TOKEN`,
      `    - { from: start, to: finish }`,
      `llm_configs:
  default: { model: gpt-4o, api_key_env: ES_TEST_OPENAI_KEY }
  keyless: { model: gpt-4o }`,
    );
    const artifact = await compileFlow(flowDir);
    expect(errorsOf(artifact.diagnostics)).toEqual([]);

    const secretPlans = artifact.entities.filter((plan) => plan.kind === 'secret');
    expect(secretPlans).toStrictEqual([
      {
        key: 'secrets.ES_TEST_BOT_TOKEN',
        section: 'secrets',
        name: 'ES_TEST_BOT_TOKEN',
        kind: 'secret',
        action: 'ensure',
        remoteName: 'es-mcp:ES_TEST_BOT_TOKEN',
        payload: { name: 'es-mcp:ES_TEST_BOT_TOKEN', value: { $env: 'ES_TEST_BOT_TOKEN' } },
      },
      {
        key: 'secrets.ES_TEST_OPENAI_KEY',
        section: 'secrets',
        name: 'ES_TEST_OPENAI_KEY',
        kind: 'secret',
        action: 'ensure',
        remoteName: 'es-mcp:ES_TEST_OPENAI_KEY',
        payload: { name: 'es-mcp:ES_TEST_OPENAI_KEY', value: { $env: 'ES_TEST_OPENAI_KEY' } },
      },
    ]);
    // Secrets are pushed before anything that references them.
    expect(artifact.entities.findIndex((plan) => plan.kind === 'secret')).toBe(0);

    const llm = artifact.entities.find((plan) => plan.key === 'llm_configs.default');
    expect(llm?.payload?.['api_key_secret_id']).toStrictEqual({ $ref: 'secrets.ES_TEST_OPENAI_KEY' });
    expect(llm?.payload).not.toHaveProperty('api_key');
    // No env → the field is omitted, so an update never clears a secret attached in the UI.
    const keyless = artifact.entities.find((plan) => plan.key === 'llm_configs.keyless');
    expect(keyless?.payload).not.toHaveProperty('api_key_secret_id');

    const bot = artifact.graph.nodes.find((candidate) => candidate.type === 'telegram-trigger') as
      | TelegramTriggerGraphNode
      | undefined;
    expect(bot?.data.telegram_bot_api_key_secret_id).toStrictEqual({ $ref: 'secrets.ES_TEST_BOT_TOKEN' });
    expect(bot?.data).not.toHaveProperty('telegram_bot_api_key');
  });
});

describe('validateKeyValueEntries (KeyValueEntriesValidator port)', () => {
  it('accepts well-formed entries in every mode', () => {
    expect(validateKeyValueEntries('read', [{ key: 'a_{variables.id}', value: 'variables.x.y' }])).toEqual([]);
    expect(validateKeyValueEntries('write', [{ key: 'a', value: 'variables.x|default' }])).toEqual([]);
    expect(validateKeyValueEntries('delete', [{ key: 'a' }])).toEqual([]);
  });

  it('flags duplicate write keys and nested read targets like the backend', () => {
    expect(
      validateKeyValueEntries('write', [
        { key: 'a', value: 'variables.x' },
        { key: 'a', value: 'variables.y' },
      ]).map((issue) => issue.index),
    ).toStrictEqual([1]);
    const nested = validateKeyValueEntries('read', [
      { key: 'a', value: 'variables.user' },
      { key: 'b', value: 'variables.user.name' },
      { key: 'c', value: 'variables.username' },
    ]);
    expect(nested).toStrictEqual([
      { index: 1, message: "'variables.user.name' is inside 'variables.user' (entry 0); use a different variable." },
    ]);
  });

  it('rejects private and DotDict-method names and unbalanced placeholders', () => {
    const issues = validateKeyValueEntries('read', [
      { key: 'a', value: 'variables._secret' },
      { key: 'b', value: 'variables.items' },
      { key: 'c_{variables.id', value: 'variables.c' },
    ]);
    expect(issues.map((issue) => issue.index)).toStrictEqual([0, 1, 2]);
  });

  it('rejects a value on a delete entry and caps the entry count', () => {
    expect(validateKeyValueEntries('delete', [{ key: 'a', value: 'variables.x' }])[0]?.message).toContain(
      "unknown fields ['value']",
    );
    const many = Array.from({ length: 501 }, (_, index) => ({ key: `k${index}` }));
    expect(validateKeyValueEntries('delete', many)[0]).toStrictEqual({
      index: null,
      message: 'A Key-Value node can have at most 500 keys.',
    });
  });
});
