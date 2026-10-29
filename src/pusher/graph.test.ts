import { describe, expect, it } from 'vitest';

import type { FlowLock } from '../flow-source/lockfile.js';
import { getNodeDiff } from '../graph/diff.js';
import type { GraphNode, GraphNodeBase, GraphState } from '../graph/graph-state.js';
import { dropRemovedConditionalEdges, forgetMissingGraph, inheritUnrepresentableFields } from './graph.js';

function base(id: string, backendId: number, nodeName: string): GraphNodeBase {
  return {
    id,
    backendId,
    node_name: nodeName,
    position: { x: 0, y: 0 },
    color: '#fff',
    icon: 'ti',
    size: { width: 320, height: 80 },
    input_map: {},
    output_variable_path: null,
  };
}

/** What the backend holds: settings a user attached in the editor, which flow source cannot state. */
function remoteState(): GraphState {
  const nodes: GraphNode[] = [
    {
      ...base('r-py', 1, 'transform'),
      type: 'python',
      data: { id: 11, name: 'transform', code: 'c', entrypoint: 'main', secret_ids: [3], venv_id: 4, execution_timeout: 90, use_storage: false },
      test_input: {},
    },
    {
      ...base('r-hook', 2, 'hook'),
      type: 'webhook-trigger',
      data: {
        webhook_trigger: 33,
        python_code: { id: 12, name: 'hook', code: '', entrypoint: 'main', secret_ids: [], execution_timeout: 20 },
        test_payload: { order: 1 },
        use_storage: true,
      },
    },
    {
      ...base('r-bot', 3, 'bot'),
      type: 'telegram-trigger',
      data: { telegram_bot_api_key_secret_id: 21, webhook_trigger: 34, fields: [], test_payload: { message: { text: 'hi' } } },
    },
    {
      ...base('r-cdt', 4, 'classify'),
      type: 'classification-decision-table',
      data: { table: { condition_groups: [] } },
      explanations: { step: { text: 'why', fingerprint: 'f', generatedBy: 'gpt' } },
    },
  ];
  return { nodes, edges: [] };
}

/** The same nodes as the compiler emits them: none of the editor-only settings. */
function compiledState(): GraphState {
  const nodes: GraphNode[] = [
    { ...base('d-py', 1, 'transform'), type: 'python', data: { name: 'transform', code: 'c', entrypoint: 'main' }, test_input: {} },
    {
      ...base('d-hook', 2, 'hook'),
      type: 'webhook-trigger',
      data: { webhook_trigger: null, python_code: { name: 'hook', code: '', entrypoint: 'main' } },
    },
    { ...base('d-bot', 3, 'bot'), type: 'telegram-trigger', data: { telegram_bot_api_key_secret_id: null, webhook_trigger: null, fields: [] } },
    { ...base('d-cdt', 4, 'classify'), type: 'classification-decision-table', data: { table: { condition_groups: [] } } },
  ];
  return { nodes, edges: [] };
}

describe('inheritUnrepresentableFields', () => {
  it('keeps the venv, timeouts, test payloads, storage access and CDT explanations set in the editor', () => {
    const remote = remoteState();
    const desired = compiledState();

    inheritUnrepresentableFields(desired, remote);

    const [python, hook, bot, cdt] = desired.nodes;
    expect(python?.type === 'python' && python.data).toMatchObject({ id: 11, venv_id: 4, execution_timeout: 90, secret_ids: [3] });
    expect(hook?.type === 'webhook-trigger' && hook.data).toMatchObject({
      webhook_trigger: 33,
      test_payload: { order: 1 },
      use_storage: true,
      python_code: { id: 12, execution_timeout: 20 },
    });
    expect(bot?.type === 'telegram-trigger' && bot.data.test_payload).toEqual({ message: { text: 'hi' } });
    expect(cdt?.type === 'classification-decision-table' && cdt.explanations).toEqual({
      step: { text: 'why', fingerprint: 'f', generatedBy: 'gpt' },
    });

    // Nothing the source did not change is rewritten.
    const nodeDiff = getNodeDiff(remote, desired);
    for (const bucket of Object.values(nodeDiff)) expect(bucket.toUpdate).toEqual([]);
  });

  it('a source-stated value still wins over the persisted one', () => {
    const desired = compiledState();
    const python = desired.nodes[0];
    if (python?.type !== 'python') return expect.unreachable('python node missing');
    python.data.venv_id = null;

    inheritUnrepresentableFields(desired, remoteState());

    expect(python.data.venv_id).toBeNull();
  });
});

describe('conditional-edge lock entries', () => {
  const lock: FlowLock = {
    flowName: 'flow',
    graphId: 9,
    saveVersion: 3,
    entities: {
      'nodes.work': { backendId: 1, contentHash: 'h' },
      'conditional_edges.work': { backendId: 2, contentHash: 'h' },
      'agents.writer': { backendId: 3, contentHash: 'h' },
    },
    documents: {},
  };

  it('are dropped after a push: EpicStaff no longer has conditional edges', () => {
    expect(Object.keys(dropRemovedConditionalEdges(lock).entities)).toEqual(['nodes.work', 'agents.writer']);
  });

  it('are dropped with the node ids when the locked graph is gone', () => {
    const forgotten = forgetMissingGraph(lock);
    expect(forgotten.graphId).toBeNull();
    expect(forgotten.saveVersion).toBe(0);
    expect(Object.keys(forgotten.entities)).toEqual(['agents.writer']);
  });
});
