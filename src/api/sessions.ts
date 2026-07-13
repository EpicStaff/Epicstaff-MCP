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

  /** POST run-session/ — multipart, exactly like the frontend RunGraphService.runGraph(). */
  async runGraph(graphId: number, initialState: Record<string, unknown> = {}): Promise<{ session_id: number }> {
    const formData = new FormData();
    formData.append('graph_id', String(graphId));
    formData.append('initial_state', JSON.stringify(initialState));
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
