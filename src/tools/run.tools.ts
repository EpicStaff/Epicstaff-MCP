import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { SessionsApi, TERMINAL_SESSION_STATUSES, summarizeMessages } from '../api/sessions.js';
import { runTool } from './auth-org.tools.js';

/**
 * Test-loop tools: run a pushed flow, poll it, read its messages, debug it.
 * The "test" step of write → build → test.
 */
export function registerRunTools(server: McpServer, context: AppContext): void {
  const sessions = new SessionsApi(context.client);

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
        'Statuses: pending, run, wait_for_user (needs answer_to_llm), end, error, stop, expired.',
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
    'answer_to_llm',
    {
      title: 'Answer a human-input request',
      description:
        'Respond to a session in wait_for_user status. The waiting prompt and its crew_id/execution_order/name ' +
        'are in the session status_data / messages.',
      inputSchema: {
        session_id: z.number().int(),
        crew_id: z.number().int(),
        execution_order: z.number().int(),
        name: z.string(),
        answer: z.string(),
      },
    },
    async (request) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await sessions.answerToLlm(request);
        return { answered: request.session_id };
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
}
