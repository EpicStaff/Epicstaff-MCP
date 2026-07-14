import type { EpicStaffClient } from '../http/client.js';

/**
 * Session / run API — ported from the frontend's
 * features/flows/services/run-graph-session.service.ts (multipart run-session)
 * and flows-sessions.service.ts (sessions read surface), plus
 * pages/running-graph/services/answer-to-llm.service.ts.
 */
export type GraphSessionStatus = 'run' | 'error' | 'end' | 'wait_for_user' | 'pending' | 'expired' | 'stop';

export const TERMINAL_SESSION_STATUSES: ReadonlySet<GraphSessionStatus> = new Set([
  'end',
  'error',
  'stop',
  'expired',
]);

export interface GraphSession {
  id: number;
  graph: { id: number; name: string; metadata: Record<string, unknown> };
  status: GraphSessionStatus;
  status_data: Record<string, unknown>;
  initial_state: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
}

export interface GraphSessionLight {
  id: number;
  graph_id: number;
  graph_name: string;
  status: GraphSessionStatus;
  status_updated_at: string;
  created_at: string;
  finished_at: string | null;
}

export interface GraphMessage {
  id: number;
  session_id: number;
  created_at: string;
  message_data: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Paginated<T> {
  count: number;
  results: T[];
}

export interface AnswerToLlmRequest {
  session_id: number;
  crew_id: number;
  execution_order: number;
  name: string;
  answer: string;
}

export class SessionsApi {
  constructor(private readonly client: EpicStaffClient) {}

  /**
   * POST run-session/ — multipart.
   *
   * The seed variables MUST be sent under the form field `variables`: the backend
   * `RunSessionSerializer` only reads `variables` (a JSONField) and ignores everything else.
   * The EpicStaff web `RunGraphService` posts this as `initial_state`, which the backend
   * silently drops — so per-run input never reaches the graph and it falls back to the graph's
   * persistent/start-node defaults. We deliberately diverge from the frontend here and post the
   * field the backend actually consumes.
   */
  async runGraph(graphId: number, initialState: Record<string, unknown> = {}): Promise<{ session_id: number }> {
    const formData = new FormData();
    formData.append('graph_id', String(graphId));
    formData.append('variables', JSON.stringify(initialState));
    return this.client.post('run-session/', { formData });
  }

  async getSession(sessionId: number): Promise<GraphSession> {
    return this.client.get(`sessions/${sessionId}/`);
  }

  /** Lightweight status poll — the headless substitute for the browser-only SSE stream. */
  async getSessionUpdates(sessionId: number): Promise<{ status: GraphSessionStatus }> {
    return this.client.get(`sessions/${sessionId}/get-updates/`);
  }

  async listSessions(options: {
    graphId?: number;
    status?: GraphSessionStatus[];
    limit?: number;
    offset?: number;
  }): Promise<Paginated<GraphSessionLight>> {
    return this.client.get('sessions/', {
      query: {
        detailed: false,
        graph_id: options.graphId,
        status: options.status?.join(','),
        limit: options.limit ?? 20,
        offset: options.offset,
      },
    });
  }

  async stopSession(sessionId: number): Promise<void> {
    await this.client.post(`sessions/${sessionId}/stop/`, { body: {} });
  }

  async getSessionWarnings(sessionId: number): Promise<unknown> {
    return this.client.get(`sessions/${sessionId}/warnings/`);
  }

  async getSessionMessages(
    sessionId: number,
    limit = 100,
    offset = 0,
  ): Promise<Paginated<GraphMessage>> {
    return this.client.get('graph-session-messages/', {
      query: { session_id: sessionId, limit, offset },
    });
  }

  /** Respond to a wait_for_user human-input request mid-run. */
  async answerToLlm(request: AnswerToLlmRequest): Promise<unknown> {
    return this.client.post('answer-to-llm/', { body: request });
  }
}

export interface ConciseMessage {
  node: string;
  order: number;
  kind: string;
  detail: string;
}

export interface ConciseTrace {
  count: number;
  messages: ConciseMessage[];
  /** The final composed reply, taken from the terminal state's `variables.reply` when present. */
  final_reply: string | null;
  final_variables: Record<string, unknown> | null;
}

/**
 * Collapse the verbose per-message trace into a compact, token-cheap timeline.
 * Full-state snapshots (which dominate the raw payload) are dropped; we keep only the
 * meaningful signal per node — agent replies, python results, and errors — plus the
 * terminal state's variables so the caller can read `variables.reply` without paging.
 */
export function summarizeMessages(messages: GraphMessage[]): ConciseTrace {
  const out: ConciseMessage[] = [];
  let finalVariables: Record<string, unknown> | null = null;

  for (const message of messages) {
    const data = (message.message_data ?? {}) as Record<string, any>;
    const node = String((message as any).name ?? '');
    const order = Number((message as any).execution_order ?? 0);

    const state = data.state as Record<string, any> | undefined;
    if (state?.variables && typeof state.variables === 'object') {
      finalVariables = state.variables as Record<string, unknown>;
    }

    const type = data.message_type;
    if (type === 'agent_node_stream' && data.event === 'task_finish') {
      out.push({ node, order, kind: 'agent_reply', detail: String(data.data?.message ?? '') });
    } else if (type === 'python' && data.python_code_execution_data) {
      const py = data.python_code_execution_data;
      const detail = py.returncode === 0 ? String(py.result_data ?? '') : `error: ${py.stderr ?? py.result_data ?? ''}`;
      out.push({ node, order, kind: 'python_result', detail });
    } else if (type === 'error' || data.event === 'error') {
      out.push({ node, order, kind: 'error', detail: JSON.stringify(data.data ?? data) });
    } else if (type === 'graph_end') {
      out.push({ node: node || '__graph__', order, kind: 'graph_end', detail: '' });
    }
  }

  const reply = finalVariables?.reply;
  const finalReply = typeof reply === 'string' ? reply : reply == null ? null : JSON.stringify(reply);

  return { count: out.length, messages: out, final_reply: finalReply, final_variables: finalVariables };
}
