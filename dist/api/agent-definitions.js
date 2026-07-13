function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class AgentDefinitionsApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async list() {
        return unwrap(await this.client.get('agent-definitions/', {
            query: { limit: 1000 },
        }));
    }
    async get(id) {
        return this.client.get(`agent-definitions/${id}/`);
    }
    async create(request) {
        return this.client.post('agent-definitions/', { body: request });
    }
    async update(id, request) {
        return this.client.patch(`agent-definitions/${id}/`, { body: request });
    }
}
