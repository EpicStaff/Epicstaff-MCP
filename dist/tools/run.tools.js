import { z } from 'zod';
import { SessionsApi, TERMINAL_SESSION_STATUSES } from '../api/sessions.js';
import { runTool } from './auth-org.tools.js';
/**
 * Test-loop tools: run a pushed flow, poll it, read its messages, debug it.
 * The "test" step of write → build → test.
 */
export function registerRunTools(server, context) {
    const sessions = new SessionsApi(context.client);
    server.registerTool('run_flow', {
        title: 'Run a flow',
        description: 'Start a run session for a pushed flow graph (POST run-session/). Returns the session_id to poll with ' +
            'get_session_updates and read with get_session_messages. initial_state seeds the graph state variables.',
        inputSchema: {
            graph_id: z.number().int().describe('Backend graph id (from push_flow output or list_graphs)'),
            initial_state: z
                .record(z.unknown())
                .optional()
                .describe('Initial state variables for the run (JSON object). Defaults to {}.'),
        },
    }, async ({ graph_id, initial_state }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const result = await sessions.runGraph(graph_id, initial_state ?? {});
        return {
            session_id: result.session_id,
            next: 'Poll get_session_updates until the status is terminal (end/error/stop/expired) or wait_for_user.',
        };
    }));
    server.registerTool('get_session', {
        title: 'Get session details',
        description: 'Full session record: status, status_data (error details, waiting-for-user prompts), initial_state, timestamps.',
        inputSchema: {
            session_id: z.number().int(),
        },
    }, async ({ session_id }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const session = await sessions.getSession(session_id);
        return {
            ...session,
            isTerminal: TERMINAL_SESSION_STATUSES.has(session.status),
        };
    }));
    server.registerTool('get_session_updates', {
        title: 'Poll session status',
        description: 'Lightweight status poll for a running session (the headless substitute for the UI SSE stream). ' +
            'Statuses: pending, run, wait_for_user (needs answer_to_llm), end, error, stop, expired.',
        inputSchema: {
            session_id: z.number().int(),
        },
    }, async ({ session_id }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const updates = await sessions.getSessionUpdates(session_id);
        return {
            ...updates,
            isTerminal: TERMINAL_SESSION_STATUSES.has(updates.status),
        };
    }));
    server.registerTool('get_session_messages', {
        title: 'Read session messages',
        description: 'The full execution trace of a session — per-node messages, agent outputs, errors. ' +
            'The primary debugging surface after (or during) a run.',
        inputSchema: {
            session_id: z.number().int(),
            limit: z.number().int().min(1).max(500).optional().describe('Page size, default 100'),
            offset: z.number().int().min(0).optional(),
        },
    }, async ({ session_id, limit, offset }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        return sessions.getSessionMessages(session_id, limit ?? 100, offset ?? 0);
    }));
    server.registerTool('list_sessions', {
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
    }, async ({ graph_id, status, limit, offset }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        return sessions.listSessions({ graphId: graph_id, status, limit, offset });
    }));
    server.registerTool('stop_session', {
        title: 'Stop a session',
        description: 'Stop a running session.',
        inputSchema: {
            session_id: z.number().int(),
        },
    }, async ({ session_id }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        await sessions.stopSession(session_id);
        return { stopped: session_id };
    }));
    server.registerTool('answer_to_llm', {
        title: 'Answer a human-input request',
        description: 'Respond to a session in wait_for_user status. The waiting prompt and its crew_id/execution_order/name ' +
            'are in the session status_data / messages.',
        inputSchema: {
            session_id: z.number().int(),
            crew_id: z.number().int(),
            execution_order: z.number().int(),
            name: z.string(),
            answer: z.string(),
        },
    }, async (request) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        await sessions.answerToLlm(request);
        return { answered: request.session_id };
    }));
    server.registerTool('get_collection_status', {
        title: 'Check knowledge collection status',
        description: 'Check a knowledge collection: its indexing status and attached RAG types. ' +
            'Use before running a flow whose agents rely on RAG — a collection is only usable once indexed.',
        inputSchema: {
            collection_id: z.number().int(),
        },
    }, async ({ collection_id }) => runTool(async () => {
        await context.auth.ensureAuthenticated();
        const [collection, rags] = await Promise.all([
            context.client.get(`source-collections/${collection_id}/`),
            context.client
                .get(`source-collections/${collection_id}/available-rags/`)
                .catch(() => undefined),
        ]);
        return { collection, availableRags: rags };
    }));
}
