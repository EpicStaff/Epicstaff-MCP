function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class LegacyCrewApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async listCrews() {
        return unwrap(await this.client.get('crews/', { query: { limit: 1000 } }));
    }
    async createCrew(request) {
        return this.client.post('crews/', { body: request });
    }
}
