/** Some list endpoints return arrays, others DRF pages — normalize both. */
function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class LlmApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async listProviders() {
        return unwrap(await this.client.get('providers/', { query: { limit: 1000 } }));
    }
    async listModels() {
        return unwrap(await this.client.get('llm-models/', { query: { limit: 1000 } }));
    }
    async listConfigs() {
        return unwrap(await this.client.get('llm-configs/', { query: { limit: 1000 } }));
    }
    async createConfig(request) {
        return this.client.post('llm-configs/', { body: request });
    }
    async updateConfig(id, request) {
        return this.client.patch(`llm-configs/${id}/`, { body: request });
    }
    async getDefaultConfig() {
        return this.client.get('default-llm-config/').catch(() => undefined);
    }
    async listEmbeddingConfigs() {
        return unwrap(await this.client.get('embedding-configs/', {
            query: { limit: 1000 },
        }));
    }
}
