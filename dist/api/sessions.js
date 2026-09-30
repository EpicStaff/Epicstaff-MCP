export const TERMINAL_SESSION_STATUSES = new Set([
    'end',
    'error',
    'stop',
    'expired',
]);
export class SessionsApi {
    client;
    constructor(client) {
        this.client = client;
    }
    /** POST run-session/ — multipart, exactly like the frontend RunGraphService.runGraph(). */
    async runGraph(graphId, initialState = {}) {
        const formData = new FormData();
        formData.append('graph_id', String(graphId));
        formData.append('initial_state', JSON.stringify(initialState));
        return this.client.post('run-session/', { formData });
    }
    async getSession(sessionId) {
        return this.client.get(`sessions/${sessionId}/`);
    }
    /** Lightweight status poll — the headless substitute for the browser-only SSE stream. */
    async getSessionUpdates(sessionId) {
        return this.client.get(`sessions/${sessionId}/get-updates/`);
    }
    async listSessions(options) {
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
    async stopSession(sessionId) {
        await this.client.post(`sessions/${sessionId}/stop/`, { body: {} });
    }
    async getSessionWarnings(sessionId) {
        return this.client.get(`sessions/${sessionId}/warnings/`);
    }
    async getSessionMessages(sessionId, limit = 100, offset = 0) {
        return this.client.get('graph-session-messages/', {
            query: { session_id: sessionId, limit, offset },
        });
    }
    /** Respond to a wait_for_user human-input request mid-run. */
    async answerToLlm(request) {
        return this.client.post('answer-to-llm/', { body: request });
    }
}
