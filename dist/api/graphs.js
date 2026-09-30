function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class GraphsApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async listLight() {
        return unwrap(await this.client.get('graph-light/', {
            query: { limit: 1000 },
        }));
    }
    async get(graphId) {
        // _ts cache-bust matches the frontend's getGraph()
        return this.client.get(`graphs/${graphId}/`, { query: { _ts: Date.now() } });
    }
    async create(request) {
        return this.client.post('graphs/', { body: request });
    }
    /** The main persistence path — returns the full GraphDto incl. new backend ids + save_version. */
    async bulkSave(graphId, payload) {
        return this.client.post(`graphs/${graphId}/save/`, { body: payload });
    }
    async delete(graphId) {
        await this.client.delete(`graphs/${graphId}/`);
    }
    // Conditional edges — dedicated endpoints (not in bulk-save, mirroring the frontend).
    async createConditionalEdge(body) {
        return this.client.post('conditionaledges/', { body });
    }
    async updateConditionalEdge(id, body) {
        return this.client.put(`conditionaledges/${id}/`, { body });
    }
    async deleteConditionalEdge(id) {
        await this.client.delete(`conditionaledges/${id}/`);
    }
}
