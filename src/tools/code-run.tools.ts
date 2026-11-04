import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ExecutionTimeoutLimitsApi } from '../api/execution-timeout-limits.js';
import { GraphsApi } from '../api/graphs.js';
import {
  type PythonCodeResult,
  type PythonCodeRunTargetType,
  PythonCodeRunApi,
  pollPythonCodeResult,
} from '../api/python-code-run.js';
import { ApiError } from '../http/errors.js';
import type { PythonNodeDto } from '../models/nodes/python-node.js';
import type { WebhookTriggerNodeDto } from '../models/nodes/webhook-trigger-node.js';
import { runTool } from './auth-org.tools.js';
import { idOrName } from './catalog-helpers.js';
import { pickGraphNode } from './graph-node-lookup.js';

/**
 * Code test runs — the flow editor's "Run" button of a python node and of a webhook trigger node's
 * code (frontend `visual-programming/components/node-panels/shared/python-code-test-run/`): run the
 * node's STORED code with hand-picked arguments, outside any session, and read its stdout / stderr /
 * return value. The node's storage is the test-run folder, not a session's.
 */

/** Characters of stdout / stderr / result_data kept in a tool result; a longer value is cut. */
export const CODE_RUN_OUTPUT_LIMIT = 20_000;

const NODE_KINDS = ['python', 'webhook-trigger'] as const;
type CodeNodeKind = (typeof NODE_KINDS)[number];

type CodeNode = { kind: 'python'; node: PythonNodeDto } | { kind: 'webhook-trigger'; node: WebhookTriggerNodeDto };

const TARGET_TYPES: Record<CodeNodeKind, PythonCodeRunTargetType> = {
  python: 'python_node',
  'webhook-trigger': 'webhook_trigger_node',
};

function truncate(value: string | null): { value: string | null; truncated: boolean } {
  if (value === null || value.length <= CODE_RUN_OUTPUT_LIMIT) return { value, truncated: false };
  return { value: `${value.slice(0, CODE_RUN_OUTPUT_LIMIT)}…`, truncated: true };
}

/** A finished (or pending) run as tool output, long streams cut at {@link CODE_RUN_OUTPUT_LIMIT}. */
export function summarizeCodeRunResult(result: PythonCodeResult): Record<string, unknown> {
  const stdout = truncate(result.stdout ?? '');
  const stderr = truncate(result.stderr ?? '');
  const resultData = truncate(result.result_data);
  const truncatedFields = [
    ...(stdout.truncated ? ['stdout'] : []),
    ...(stderr.truncated ? ['stderr'] : []),
    ...(resultData.truncated ? ['result_data'] : []),
  ];
  return {
    execution_id: result.execution_id,
    status: result.status,
    returncode: result.returncode,
    result_data: resultData.value,
    stdout: stdout.value,
    stderr: stderr.value,
    ...(result.finished_at !== undefined ? { finished_at: result.finished_at } : {}),
    ...(truncatedFields.length > 0
      ? { truncated: `${truncatedFields.join(', ')} cut at ${CODE_RUN_OUTPUT_LIMIT} characters` }
      : {}),
  };
}

export function registerCodeRunTools(server: McpServer, context: AppContext): void {
  const graphs = new GraphsApi(context.client);
  const codeRuns = new PythonCodeRunApi(context.client);
  const timeoutLimits = new ExecutionTimeoutLimitsApi(context.client);

  server.registerTool(
    'run_node_code',
    {
      title: 'Test-run a node\'s Python code',
      description:
        'Run the Python code EpicStaff has STORED for one node of a pushed flow — a python node, or a webhook ' +
        'trigger node\'s code — with the arguments you pass, outside any session (the editor\'s code "Run"). ' +
        'Returns status, returncode, result_data, stdout and stderr. push_flow first: local edits are not ' +
        'run. variables are the keyword arguments of the entrypoint; use_last_session_input: true replays ' +
        'what a python node received in the newest ended session instead. Needs Flows UPDATE (a webhook ' +
        'trigger\'s code also Flows USE). Waits for the result up to the code\'s execution timeout plus a ' +
        'minute; wait: false returns the execution_id at once (read it with get_code_run_result).',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the pushed flow (push_flow / list_graphs).'),
        node: idOrName.describe('The node: its backend id or its node name (the flow-source node key).'),
        node_type: z
          .enum(NODE_KINDS)
          .optional()
          .describe('Narrow the lookup to python or webhook-trigger nodes (needed only when an id matches both).'),
        variables: z
          .record(z.unknown())
          .optional()
          .describe('Keyword arguments of the entrypoint, e.g. {"text": "hello", "limit": 3}. Defaults to {}.'),
        use_last_session_input: z
          .boolean()
          .optional()
          .describe('Python nodes only: run with the input the node received in the newest ended session.'),
        wait: z.boolean().default(true).describe('Wait for the result (default) or return the execution_id at once.'),
      },
    },
    async ({ graph_id, node, node_type, variables, use_last_session_input, wait }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (variables !== undefined && use_last_session_input === true) {
          throw new Error('Pass either variables or use_last_session_input: true, not both.');
        }
        const graph = await graphs.get(graph_id);
        const candidates: CodeNode[] = [
          ...(graph.python_node_list ?? []).map((pythonNode) => ({ kind: 'python' as const, node: pythonNode })),
          ...(graph.webhook_trigger_node_list ?? []).map((webhookNode) => ({
            kind: 'webhook-trigger' as const,
            node: webhookNode,
          })),
        ].filter((candidate) => node_type === undefined || candidate.kind === node_type);
        const match = pickGraphNode(candidates, node, graph_id, node_type ? `${node_type} node` : 'python or webhook-trigger node');

        let runVariables: Record<string, unknown> = variables ?? {};
        if (use_last_session_input === true) {
          if (match.kind !== 'python') {
            throw new Error('use_last_session_input applies to python nodes only — pass variables for a webhook trigger.');
          }
          const lastInput = await codeRuns.getLastTestInput(match.node.id);
          if (lastInput.input === null) {
            throw new Error(
              `No ended session has run python node "${match.node.node_name}" yet (${lastInput.detail}) — pass variables instead.`,
            );
          }
          runVariables = lastInput.input;
        }

        let executionId: string;
        try {
          ({ execution_id: executionId } = await codeRuns.runPythonCode({
            target: { type: TARGET_TYPES[match.kind], id: match.node.id },
            variables: runVariables,
          }));
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            throw new Error(
              'Running stored code was refused: it needs Flows UPDATE in the active organization' +
                `${match.kind === 'webhook-trigger' ? ', and a trigger node\'s code also Flows USE' : ''}.`,
            );
          }
          throw error;
        }

        const ran = {
          node: { kind: match.kind, id: match.node.id, node_name: match.node.node_name },
          // The caller knows the variables it passed; a replayed input is worth showing.
          ...(use_last_session_input === true ? { replayed_input: runVariables } : {}),
        };
        if (!wait) {
          return { ...ran, execution_id: executionId, next: 'Read the result with get_code_run_result(execution_id).' };
        }
        const timeoutSeconds =
          match.node.python_code?.execution_timeout ?? (await timeoutLimits.get()).default_seconds;
        const outcome = await pollPythonCodeResult(codeRuns, executionId, timeoutSeconds);
        if (!outcome.finished) {
          return {
            ...ran,
            execution_id: executionId,
            status: outcome.lastStatus,
            next:
              `No result within the code's execution timeout of ${timeoutSeconds} s and a grace period; it may ` +
              'still be running on the server. Check later with get_code_run_result(execution_id).',
          };
        }
        return { ...ran, ...summarizeCodeRunResult(outcome.result) };
      }),
  );

  server.registerTool(
    'get_code_run_result',
    {
      title: 'Read a code test-run result',
      description:
        'The result of a run_node_code run by its execution_id: status (pending / completed / error), returncode, ' +
        'result_data, stdout, stderr. Results are visible only in the organization that started the run.',
      inputSchema: {
        execution_id: z.string().min(1).describe('execution_id returned by run_node_code.'),
      },
    },
    async ({ execution_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const result = await codeRuns.getResult(execution_id);
        return {
          ...summarizeCodeRunResult(result),
          ...(result.status === 'pending' ? { next: 'Still running — call get_code_run_result again shortly.' } : {}),
        };
      }),
  );
}
