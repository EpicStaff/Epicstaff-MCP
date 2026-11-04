import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { GraphsApi } from '../api/graphs.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { SessionsApi, TERMINAL_SESSION_STATUSES, type TestRunNodeType, summarizeMessages } from '../api/sessions.js';
import { TelegramTriggerFieldsApi } from '../api/telegram-trigger-fields.js';
import { ApiError } from '../http/errors.js';
import type { TelegramTriggerNodeDto } from '../models/nodes/telegram-trigger-node.js';
import type { WebhookTriggerNodeDto } from '../models/nodes/webhook-trigger-node.js';
import { runTool } from './auth-org.tools.js';
import { idOrName } from './catalog-helpers.js';
import { pickGraphNode } from './graph-node-lookup.js';

const TRIGGER_TEST_NODE_TYPES = ['webhook-trigger', 'telegram-trigger'] as const satisfies readonly TestRunNodeType[];

type TriggerNode =
  | { kind: 'webhook-trigger'; node: WebhookTriggerNodeDto }
  | { kind: 'telegram-trigger'; node: TelegramTriggerNodeDto };

/** The state variable a test payload reaches the flow as (each strategy's `build_variables`). */
const TRIGGER_PAYLOAD_VARIABLE: Record<TestRunNodeType, string> = {
  'webhook-trigger': 'trigger_payload',
  'telegram-trigger': 'telegram_payload',
};

/**
 * RAG indexing statuses that mean a strategy has stopped progressing:
 * `completed` (indexed), `warning` (indexed with warnings — still retrievable),
 * `failed` (gave up). The only in-progress statuses are `new` and `processing`.
 */
const TERMINAL_RAG_STATUSES = new Set(['completed', 'warning', 'failed']);

interface RagStatus {
  ragId: number;
  ragType: string;
  status: string;
}

interface CollectionRagStatus {
  collectionId: number;
  rags: RagStatus[];
}

/**
 * Test-loop tools: run a pushed flow, poll it, read its messages, debug it.
 * The "test" step of write → build → test.
 */
export function registerRunTools(server: McpServer, context: AppContext): void {
  const sessions = new SessionsApi(context.client);
  const knowledge = new KnowledgeApi(context.client);
  const graphs = new GraphsApi(context.client);
  const telegramFields = new TelegramTriggerFieldsApi(context.client);

  server.registerTool(
    'run_flow',
    {
      title: 'Run a flow',
      description:
        'Start a run session for a pushed flow graph (POST run-session/). Returns the session_id to poll with ' +
        'get_session_updates and read with get_session_messages. initial_state seeds the graph state variables ' +
        '(sent to the backend as the `variables` field). For graphs with persistent_variables enabled the backend ' +
        'merges the previous ended session\'s variables as a base, so pass the FULL variables map you want (e.g. ' +
        'reset downstream fields to {} / null) to avoid stale carryover from an earlier run.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend graph id (from push_flow output or list_graphs)'),
        initial_state: z
          .record(z.unknown())
          .optional()
          .describe(
            'Initial state variables for the run, keyed by top-level variable name ' +
              '(e.g. {"chat": {"message": "..."}, "quote": {}, "reply": null}). Defaults to {}.',
          ),
      },
    },
    async ({ graph_id, initial_state }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const result = await sessions.runGraph(graph_id, initial_state ?? {});
        return {
          session_id: result.session_id,
          next: 'Poll get_session_updates until the status is terminal (end/error/stop/expired) or wait_for_user.',
        };
      }),
  );

  server.registerTool(
    'run_flow_from_trigger',
    {
      title: 'Run a flow from a trigger node with a test payload',
      description:
        'Start a run at a webhook or Telegram trigger node of a pushed flow with a hand-written payload, as if the ' +
        'webhook / Telegram update had arrived (POST run-session/test/) — no tunnel, webhook trigger or bot needed. ' +
        'Unlike run_flow (start node + initial_state) this exercises the trigger path: a webhook payload reaches ' +
        'the flow as variables.trigger_payload (through the node\'s code), a Telegram one as ' +
        'variables.telegram_payload. A Telegram payload looks like an update ({"message": {"text": "hi", ...}}) ' +
        'and may only use the parents and fields selected on the node (list_telegram_trigger_fields; fields are ' +
        'selected in the EpicStaff editor). Omit payload to use the test payload saved on the node. Needs Flows ' +
        'UPDATE and USE. Returns the session_id to poll like run_flow.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend id of the pushed flow.'),
        node: idOrName.describe('The trigger node: its backend id or its node name (the flow-source node key).'),
        node_type: z
          .enum(TRIGGER_TEST_NODE_TYPES)
          .optional()
          .describe('Narrow the lookup to webhook or Telegram triggers (needed only when an id matches both).'),
        payload: z
          .record(z.unknown())
          .optional()
          .describe('The test payload (a JSON object). Defaults to the test payload saved on the node.'),
      },
    },
    async ({ graph_id, node, node_type, payload }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const graph = await graphs.get(graph_id);
        const candidates: TriggerNode[] = [
          ...(graph.webhook_trigger_node_list ?? []).map((webhookNode) => ({
            kind: 'webhook-trigger' as const,
            node: webhookNode,
          })),
          ...(graph.telegram_trigger_node_list ?? []).map((telegramNode) => ({
            kind: 'telegram-trigger' as const,
            node: telegramNode,
          })),
        ].filter((candidate) => node_type === undefined || candidate.kind === node_type);
        const match = pickGraphNode(candidates, node, graph_id, node_type ? `${node_type} node` : 'trigger node');
        const testPayload = payload ?? match.node.test_payload ?? {};

        let result: { session_id: number };
        try {
          result = await sessions.runTestSession({
            graph_id,
            node_type: match.kind,
            node_id: match.node.id,
            payload: testPayload,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 400 && match.kind === 'telegram-trigger') {
            throw new Error(
              `${error.message}: ${error.bodyExcerpt ?? ''} — a Telegram test payload may use only the parents and ` +
                'fields selected on the node (list_telegram_trigger_fields lists what exists; fields are selected ' +
                'in the EpicStaff editor — flow source cannot express them, so a pushed node starts with none).',
            );
          }
          if (error instanceof ApiError && error.status === 403) {
            throw new Error('A trigger test run was refused: it needs Flows UPDATE and Flows USE in the active organization.');
          }
          throw error;
        }
        return {
          session_id: result.session_id,
          node: { kind: match.kind, id: match.node.id, node_name: match.node.node_name },
          payload_variable: `variables.${TRIGGER_PAYLOAD_VARIABLE[match.kind]}`,
          ...(payload === undefined ? { payload_source: 'the test payload saved on the node' } : {}),
          next: 'Poll get_session_updates until the status is terminal, then read get_session_messages.',
        };
      }),
  );

  server.registerTool(
    'list_telegram_trigger_fields',
    {
      title: 'List Telegram trigger fields',
      description:
        'The Telegram update fields a Telegram trigger node can select, per parent (message, callback_query), with ' +
        'their Telegram type and description. A test payload of run_flow_from_trigger may use only the fields ' +
        'selected on the node.',
      inputSchema: {
        parent: z.string().optional().describe('Only this parent (e.g. "message").'),
      },
    },
    async ({ parent }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const fields = await telegramFields.list();
        if (parent === undefined) return fields;
        const selected = fields[parent];
        if (selected === undefined) {
          throw new Error(`Unknown parent "${parent}". Parents: ${Object.keys(fields).join(', ')}.`);
        }
        return { [parent]: selected };
      }),
  );

  server.registerTool(
    'get_session',
    {
      title: 'Get session details',
      description:
        'Full session record: status, status_data (error details, waiting-for-user prompts), initial_state, timestamps.',
      inputSchema: {
        session_id: z.number().int(),
      },
    },
    async ({ session_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const session = await sessions.getSession(session_id);
        return {
          ...session,
          isTerminal: TERMINAL_SESSION_STATUSES.has(session.status),
        };
      }),
  );

  server.registerTool(
    'get_session_updates',
    {
      title: 'Poll session status',
      description:
        'Lightweight status poll for a running session (the headless substitute for the UI SSE stream). ' +
        'Statuses: pending, run, wait_for_user (waiting for human input — the MCP has no reply tool; answer-to-llm was removed upstream), end, error, stop, expired.',
      inputSchema: {
        session_id: z.number().int(),
      },
    },
    async ({ session_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const updates = await sessions.getSessionUpdates(session_id);
        return {
          ...updates,
          isTerminal: TERMINAL_SESSION_STATUSES.has(updates.status),
        };
      }),
  );

  server.registerTool(
    'get_session_messages',
    {
      title: 'Read session messages',
      description:
        'The execution trace of a session — per-node messages, agent outputs, errors. The primary ' +
        "debugging surface after (or during) a run. Defaults to view='concise': a compact timeline " +
        '(agent replies, python results, errors) plus the terminal `final_reply` and `final_variables`, ' +
        "which is what you usually want and is far cheaper in tokens. Use view='full' for the raw " +
        'paginated messages (large — includes per-message state snapshots).',
      inputSchema: {
        session_id: z.number().int(),
        view: z
          .enum(['concise', 'full'])
          .optional()
          .describe("'concise' (default) collapses the trace and surfaces final_reply; 'full' returns raw messages."),
        limit: z.number().int().min(1).max(500).optional().describe('Page size for full view / fetch size, default 100'),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ session_id, view, limit, offset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const page = await sessions.getSessionMessages(session_id, limit ?? 100, offset ?? 0);
        if (view === 'full') return page;
        return summarizeMessages(page.results);
      }),
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description: 'List run sessions, optionally filtered by graph and status. Newest first.',
      inputSchema: {
        graph_id: z.number().int().optional(),
        status: z
          .array(z.enum(['run', 'error', 'end', 'wait_for_user', 'pending', 'expired', 'stop']))
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ graph_id, status, limit, offset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return sessions.listSessions({ graphId: graph_id, status, limit, offset });
      }),
  );

  server.registerTool(
    'stop_session',
    {
      title: 'Stop a session',
      description: 'Stop a running session.',
      inputSchema: {
        session_id: z.number().int(),
      },
    },
    async ({ session_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await sessions.stopSession(session_id);
        return { stopped: session_id };
      }),
  );

  server.registerTool(
    'get_collection_status',
    {
      title: 'Check knowledge collection status',
      description:
        'Check a knowledge collection: its indexing status and attached RAG types. ' +
        'Use before running a flow whose agents rely on RAG — a collection is only usable once indexed.',
      inputSchema: {
        collection_id: z.number().int(),
      },
    },
    async ({ collection_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const [collection, rags] = await Promise.all([
          context.client.get<Record<string, unknown>>(`source-collections/${collection_id}/`),
          context.client
            .get<unknown>(`source-collections/${collection_id}/available-rags/`)
            .catch(() => undefined),
        ]);
        return { collection, availableRags: rags };
      }),
  );

  server.registerTool(
    'wait_for_collections',
    {
      title: 'Wait for knowledge collections to finish indexing',
      description:
        'Block until every RAG strategy on the given collections reaches a terminal indexing state ' +
        '(completed / warning / failed), or the timeout elapses — the join step before running a flow that ' +
        'relies on RAG. Polls the SERVER directly (never the lockfile). Pair with provision_knowledge, which ' +
        'starts indexing early and returns the collection ids to pass here.',
      inputSchema: {
        collection_ids: z
          .array(z.number().int())
          .min(1)
          .describe('Backend ids of the collections to wait on (from provision_knowledge / push_flow).'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Give up waiting after this many seconds (default 600).'),
        poll_interval_seconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Seconds between status polls (default 5).'),
      },
    },
    async ({ collection_ids, timeout_seconds, poll_interval_seconds }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const timeoutMs = (timeout_seconds ?? 600) * 1000;
        const intervalMs = (poll_interval_seconds ?? 5) * 1000;
        const deadline = Date.now() + timeoutMs;

        let collections: CollectionRagStatus[] = [];
        let allTerminal = false;
        for (;;) {
          const fetched = await Promise.all(collection_ids.map((id) => knowledge.getCollection(id)));
          collections = fetched.map((collection, index) => {
            const rags = (collection.rag_configurations ?? []) as Array<{
              rag_id: number;
              rag_type: string;
              status: string;
            }>;
            return {
              collectionId: collection_ids[index]!,
              rags: rags.map((rag) => ({ ragId: rag.rag_id, ragType: rag.rag_type, status: rag.status })),
            };
          });
          allTerminal = collections.every((collection) =>
            collection.rags.every((rag) => TERMINAL_RAG_STATUSES.has(rag.status)),
          );
          if (allTerminal || Date.now() >= deadline) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }

        const anyFailed = collections.some((collection) =>
          collection.rags.some((rag) => rag.status === 'failed'),
        );
        const timedOut = !allTerminal;
        const allCompleted = allTerminal && !anyFailed;

        let next: string;
        if (allCompleted) {
          next = 'All RAGs finished indexing — the collections are retrievable. Run the flow with run_flow.';
        } else if (timedOut) {
          next =
            'Timed out before every RAG finished indexing — some are still new/processing. Increase ' +
            'timeout_seconds and call wait_for_collections again, or inspect with get_collection_status.';
        } else {
          next =
            'One or more RAGs failed to index — retrieval will be incomplete. Inspect with ' +
            'get_collection_status, fix the collection/documents, and re-index before running.';
        }

        return { collections, allCompleted, timedOut, next };
      }),
  );
}
