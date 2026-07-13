function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class SurfacesApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async list() {
        return unwrap(await this.client.get('surfaces/', { query: { limit: 1000 } }));
    }
    async get(id) {
        return this.client.get(`surfaces/${id}/`);
    }
    async create(request) {
        return this.client.post('surfaces/', { body: request });
    }
    async update(id, request) {
        return this.client.put(`surfaces/${id}/`, { body: request });
    }
}
