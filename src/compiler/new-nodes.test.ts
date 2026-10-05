import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeRetrieverGraphNode, TelegramTriggerGraphNode } from '../graph/graph-state.js';
import { compileFlow } from './index.js';

/** knowledge-retriever nodes, the rejected key-value type and secret-backed credentials, end to end through the compiler. */
describe('compileFlow: knowledge-retriever, key-value rejection, secrets', () => {
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

  it('rejects a key-value node — EpicStaff 1.2.x has no Key-Value tables — and emits no table plan', async () => {
    writeFlow(
      `    lookup:
      type: key-value
      table: User Profiles
      mode: read
      entries:
        - { key: "profile_{variables.user_id}", value: variables.profile }`,
      `    - { from: start, to: lookup }
    - { from: lookup, to: finish }`,
    );
    const artifact = await compileFlow(flowDir);
    const errors = errorsOf(artifact.diagnostics);
    expect(errors.map((error) => error.path)).toStrictEqual(['flow.nodes.lookup.type']);
    expect(errors[0]?.message).toContain('key-value nodes need EpicStaff 1.3+; this is MCP 1.2.x for EpicStaff 1.2.x');
    expect(artifact.graph.nodes).toStrictEqual([]);
    expect(artifact.entities).toStrictEqual([]);
  });

  it('rejects api_key_env / bot_token_env naming the MCP server own variables (EPICSTAFF_*, ES_MCP_*)', async () => {
    writeFlow(
      `    bot:
      type: telegram-trigger
      bot_token_env: es_mcp_state_dir`,
      `    - { from: start, to: finish }`,
      `llm_configs:
  leak: { model: gpt-4o, api_key_env: EPICSTAFF_PASSWORD }`,
    );
    const artifact = await compileFlow(flowDir);
    const errors = errorsOf(artifact.diagnostics);
    expect(errors.map((error) => error.path).sort()).toStrictEqual([
      'flow.nodes.bot.bot_token_env',
      'llm_configs.leak.api_key_env',
    ]);
    expect(errors[0]!.message).toMatch(/MCP server's own credentials/);
    expect(artifact.entities.filter((plan) => plan.kind === 'secret')).toStrictEqual([]);
  });

  it('mirrors the backend LLMConfig bounds: max_tokens >= 500, temperature 0..2, context_window >= 1000', async () => {
    writeFlow(
      ``,
      `    - { from: start, to: finish }`,
      `llm_configs:
  short: { model: gpt-4o, max_tokens: 499 }
  hot: { model: gpt-4o, temperature: 2.5 }
  narrow: { model: gpt-4o, params: { context_window: 999, max_tokens: 100 } }
  ok: { model: gpt-4o, max_tokens: 500, temperature: 0, params: { context_window: 1000, top_p: 0.9 } }`,
    );
    const errors = errorsOf((await compileFlow(flowDir)).diagnostics);
    expect(errors.map((error) => error.path).sort()).toStrictEqual([
      'llm_configs.hot.temperature',
      'llm_configs.narrow.params.context_window',
      'llm_configs.narrow.params.max_tokens',
      'llm_configs.short.max_tokens',
    ]);
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
